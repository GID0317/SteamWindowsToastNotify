import {
	IconsModule,
	DialogButton,
	Dropdown,
	Field,
	Toggle,
	callable,
	definePlugin,
	EClientNotificationType,
	sleep,
} from '@steambrew/client';

type RecordValue = Record<string, unknown>;

type NativeToastAction = {
	label: string;
	url: string;
};

type NativeToastPayload = {
	typeId: number;
	typeName: string;
	title: string;
	body: string;
	icon?: string;
	launchUrl?: string;
	playSound: boolean;
	actions?: NativeToastAction[];
	eventKey?: string;
	eventTimestampMs?: number;
	friendSteamId?: string;
	debugTraceId?: string;
	debugSource?: string;
};

type PopupExtraction = {
	title: string;
	body: string;
	launchUrl?: string;
	icon?: string;
	steamIdHint?: string;
	usable: boolean;
};

type StructuredNotificationCandidate = {
	payload: NativeToastPayload;
	capturedAt: number;
	fingerprint: string;
	source: string;
};

type RecentGroupChatContext = {
	groupTitle: string;
	sender: string;
	icon?: string;
	launchUrl?: string;
	capturedAt: number;
};

type FriendProfile = {
	displayName?: string;
	avatarUrl?: string;
};

type AppProfile = {
	name?: string;
};

type RuntimeConfig = {
	enabled: boolean;
	hideSteamToast: boolean;
	priorityMode: PriorityMode;
};

const PRIORITY_MODE = {
	NONE: 'none',
	ALL: 'all',
	IMPORTANT_ONLY: 'important_only',
} as const;
type PriorityMode = (typeof PRIORITY_MODE)[keyof typeof PRIORITY_MODE];

const CONFIG_STORAGE_KEY = 'steam-native-toasts.config.v1';
const DEFAULT_RUNTIME_CONFIG: RuntimeConfig = {
	enabled: true,
	hideSteamToast: true,
	priorityMode: PRIORITY_MODE.IMPORTANT_ONLY,
};

const sendNativeToast = callable<
	[{ payload_blob: string }],
	string | number | boolean | void
>('send_native_toast');
const writeTraceLog = callable<
	[{ message: string }],
	boolean
>('write_trace_log');

const ALLOWED_ACTION_PROTOCOL = /^(steam|https?):\/\//i;
const STRUCTURED_CANDIDATE_TTL_MS = 15_000;
const FORWARDED_SIGNATURE_TTL_MS = 15_000;
const DUPLICATE_FORWARD_WINDOW_MS = 900;
const STRUCTURED_EVENT_KEY_TTL_MS = 86_400_000;
const STRUCTURED_CAPTURE_INTERVAL_MS = 1_000;
const MESSAGE_NOTIFICATION_TYPES = new Set<number>([
	EClientNotificationType.FriendMessage,
	EClientNotificationType.GroupChatMessage,
	EClientNotificationType.IncomingVoiceChat,
	EClientNotificationType.FriendOnline,
	EClientNotificationType.FriendInGame,
]);
const DEFAULT_ACTION_LABEL_BY_TYPE = new Map<number, string>([
	[EClientNotificationType.FriendInvite, 'Respond'],
	[EClientNotificationType.FriendMessage, 'Open Chat'],
	[EClientNotificationType.GroupChatMessage, 'Open Chat'],
	[EClientNotificationType.IncomingVoiceChat, 'Open Chat'],
	[EClientNotificationType.FriendInGame, 'Join'],
	[EClientNotificationType.TradeOffer, 'View Offer'],
	[EClientNotificationType.DownloadComplete, 'Launch'],
	[EClientNotificationType.FamilyInvite, 'View Invite'],
	[EClientNotificationType.FamilyPurchaseRequest, 'View Request'],
]);
const GENERIC_TEXT_VALUES = new Set<string>([
	'general',
	'steam notification',
	'you have a new steam notification.',
]);
const OVERLAY_TUTORIAL_PATTERNS = [
	/^press shift\+tab to begin$/i,
	/^access steam features from the overlay while playing\.?$/i,
];
const GENERIC_FRIEND_MESSAGE_BODIES = new Set<string>([
	'friendmessage',
	'groupchatmessage',
	'you have a new steam notification.',
	'steam notification',
]);

let runtimeConfig: RuntimeConfig = { ...DEFAULT_RUNTIME_CONFIG };
let bridgeInitialized = false;
let structuredCaptureTimer: number | null = null;
let notificationSuppressionObserver: MutationObserver | null = null;
let notificationSuppressionStyle: HTMLStyleElement | null = null;
let fastSuppressionTimer: number | null = null;
let startupWarmupDeadline = 0;
const recentlyForwarded = new Map<string, number>();
const recentStructuredNotifications: StructuredNotificationCandidate[] = [];
const recentGroupChatContextBySender = new Map<string, RecentGroupChatContext>();
const structuredFingerprintTimes = new Map<string, number>();
const structuredEventKeyTimes = new Map<string, number>();
const fastSuppressedElements = new Map<HTMLElement, Array<{ property: string; value: string; priority: string }>>();
const resolvedFriendProfileCache = new Map<string, FriendProfile>();
const resolvedAppProfileCache = new Map<string, AppProfile>();
const FAST_SUPPRESSION_CLASS = 'steam-native-toasts-fast-hidden';
const NOTIFICATION_HOST_SELECTOR = [
	'iframe[name*="notificationtoast" i]',
	'iframe[id*="notificationtoast" i]',
	'iframe[class*="notificationtoast" i]',
	'div[id*="notificationtoast" i]',
	'div[class*="notificationtoast" i]',
	'[data-panel*="notificationtoast" i]',
].join(', ');
const STARTUP_WARMUP_WINDOW_MS = 20_000;
const TOAST_FORWARD_MIN_GAP_MS = 80;
const POPUP_EXTRACTION_RETRY_DELAYS_MS = [90, 150, 220, 320] as const;
let toastForwardQueue: Promise<void> = Promise.resolve();
let nextToastForwardEarliestMs = 0;
let nextDebugTraceSequence = 1;

const readConfig = (): RuntimeConfig => {
	try {
		const raw = localStorage.getItem(CONFIG_STORAGE_KEY);
		if (!raw) {
			return { ...DEFAULT_RUNTIME_CONFIG };
		}

		const parsed = JSON.parse(raw) as Partial<RuntimeConfig> & { bypassDoNotDisturb?: boolean };
		const parsedPriorityMode = (() => {
			if (parsed.priorityMode === PRIORITY_MODE.NONE || parsed.priorityMode === PRIORITY_MODE.ALL || parsed.priorityMode === PRIORITY_MODE.IMPORTANT_ONLY) {
				return parsed.priorityMode;
			}

			// Backward compatibility with older boolean setting.
			if (typeof parsed.bypassDoNotDisturb === 'boolean') {
				return parsed.bypassDoNotDisturb ? PRIORITY_MODE.IMPORTANT_ONLY : PRIORITY_MODE.NONE;
			}

			return DEFAULT_RUNTIME_CONFIG.priorityMode;
		})();
		return {
			enabled: typeof parsed.enabled === 'boolean' ? parsed.enabled : DEFAULT_RUNTIME_CONFIG.enabled,
			hideSteamToast: typeof parsed.hideSteamToast === 'boolean' ? parsed.hideSteamToast : DEFAULT_RUNTIME_CONFIG.hideSteamToast,
			priorityMode: parsedPriorityMode,
		};
	} catch {
		return { ...DEFAULT_RUNTIME_CONFIG };
	}
};

const writeConfig = (next: RuntimeConfig): void => {
	runtimeConfig = next;
	try {
		localStorage.setItem(CONFIG_STORAGE_KEY, JSON.stringify(next));
	} catch {
		// Ignore storage failures.
	}

	refreshGlobalNotificationSuppression();
};

const asRecord = (value: unknown): RecordValue | undefined => {
	if (!value || typeof value !== 'object' || Array.isArray(value)) {
		return undefined;
	}

	return value as RecordValue;
};

const fromMaybeCallable = (value: unknown): unknown => {
	if (typeof value !== 'function') {
		return value;
	}

	try {
		return (value as () => unknown)();
	} catch {
		return undefined;
	}
};

const asString = (value: unknown): string | undefined => {
	const resolved = fromMaybeCallable(value);
	if (typeof resolved !== 'string') {
		return undefined;
	}

	const trimmed = resolved.trim();
	return trimmed.length > 0 ? trimmed : undefined;
};

const asNumber = (value: unknown): number | undefined => {
	const resolved = fromMaybeCallable(value);
	if (typeof resolved === 'number' && Number.isFinite(resolved)) {
		return resolved;
	}

	if (typeof resolved === 'string' && resolved.trim().length > 0) {
		const parsed = Number(resolved);
		if (Number.isFinite(parsed)) {
			return parsed;
		}
	}

	return undefined;
};

const firstString = (source: RecordValue | undefined, keys: string[]): string | undefined => {
	if (!source) {
		return undefined;
	}

	for (const key of keys) {
		const value = asString(source[key]);
		if (value) {
			return value;
		}
	}

	return undefined;
};

const firstValue = (source: RecordValue | undefined, keys: string[]): unknown => {
	if (!source) {
		return undefined;
	}

	for (const key of keys) {
		if (source[key] !== undefined && source[key] !== null) {
			return source[key];
		}
	}

	return undefined;
};

const sanitizeActionUrl = (candidate: string | undefined): string | undefined => {
	if (!candidate) {
		return undefined;
	}

	return ALLOWED_ACTION_PROTOCOL.test(candidate) ? candidate : undefined;
};

const asPositiveIntegerString = (value: unknown): string | undefined => {
	const resolved = fromMaybeCallable(value);
	if (typeof resolved === 'number' && Number.isFinite(resolved) && resolved > 0) {
		return String(Math.trunc(resolved));
	}

	if (typeof resolved === 'string') {
		const compact = resolved.trim();
		if (/^\d+$/.test(compact)) {
			const normalized = compact.replace(/^0+/, '') || '0';
			return normalized === '0' ? undefined : normalized;
		}
	}

	return undefined;
};

const profileText = (value: unknown): string | undefined => {
	const text = asString(value);
	if (!text) {
		return undefined;
	}

	return hasMeaningfulText(text) ? text : undefined;
};

const firstNonGenericString = (source: RecordValue | undefined, keys: string[]): string | undefined => {
	if (!source) {
		return undefined;
	}

	for (const key of keys) {
		const value = asString(source[key]);
		if (!value) {
			continue;
		}
		if (!isGenericIncomingVoiceText(value)) {
			return value;
		}
	}

	return undefined;
};

const profileImageUrl = (value: unknown): string | undefined => {
	const text = asString(value);
	if (!text) {
		return undefined;
	}

	return /^https?:\/\//i.test(text) ? text : undefined;
};

const avatarHashToUrl = (value: unknown): string | undefined => {
	const raw = asString(value);
	if (!raw) {
		return undefined;
	}

	const compact = raw.trim().toLowerCase();
	if (!/^[a-f0-9]{40}$/.test(compact)) {
		return undefined;
	}

	return `https://avatars.steamstatic.com/${compact}_full.jpg`;
};

const isLikelyAvatarUrl = (value: string | undefined): boolean => {
	const text = asString(value);
	if (!text) {
		return false;
	}

	const normalized = text.toLowerCase();
	return (
		/\/avatars\//.test(normalized) ||
		/community\/public\/images\/avatars\//.test(normalized) ||
		/avatar/.test(normalized)
	);
};

const preferredAvatarUrl = (...candidates: Array<string | undefined>): string | undefined => {
	for (const candidate of candidates) {
		const text = asString(candidate);
		if (!text) {
			continue;
		}
		if (isLikelyAvatarUrl(text)) {
			return text;
		}
	}

	for (const candidate of candidates) {
		const text = asString(candidate);
		if (!text) {
			continue;
		}
		if (/^https?:\/\//i.test(text)) {
			return text;
		}
	}

	return undefined;
};

const getWindowObject = (): RecordValue =>
	window as unknown as RecordValue;

const asSteamIdStringFromUnknown = (value: unknown): string | undefined => {
	const direct = asPositiveIntegerString(value);
	if (direct) {
		return direct;
	}

	const record = asRecord(value);
	if (!record) {
		return undefined;
	}

	const convertTo64BitString = record.ConvertTo64BitString;
	if (typeof convertTo64BitString === 'function') {
		try {
			return asPositiveIntegerString((convertTo64BitString as () => unknown).call(record));
		} catch {
			return undefined;
		}
	}

	return undefined;
};

const isGenericIncomingVoiceText = (value: string | undefined): boolean => {
	const text = asString(value);
	if (!text) {
		return true;
	}

	const normalized = normalizeWhitespace(text).toLowerCase();
	if (normalized === 'steam' || normalized === 'steam notification' || normalized === 'incomingvoicechat') {
		return true;
	}

	const compact = normalized.replace(/[.:]/g, '').trim();
	return (
		compact === 'incoming voice chat request' ||
		compact === 'incoming voice chat' ||
		compact === 'voice chat request' ||
		compact === 'steam incomingvoicechat' ||
		compact === 'steam incoming voice chat request' ||
		compact === 'steam incoming voice chat'
	);
};

const isVoiceRequestTitle = (value: string | undefined): boolean => {
	const normalized = normalizeWhitespace(value ?? '').toLowerCase().replace(/[.:]+$/g, '');
	return normalized === 'voice chat request' || normalized === 'incoming voice chat request';
};

const looksLikeVoiceRequestPopup = (extracted: PopupExtraction): boolean =>
	isVoiceRequestTitle(extracted.title) ||
	/\b(?:voice chat request|incoming voice chat|opened voice chat|calling you)\b/i.test(`${extracted.title} ${extracted.body}`);

const extractLooseFriendProfile = (record: RecordValue | undefined): FriendProfile | null => {
	if (!record) {
		return null;
	}

	const persona = asRecord(record.persona);
	const displayName =
		profileText(record.personaName) ??
		profileText(record.displayName) ??
		profileText(record.name) ??
		profileText(record.title) ??
		profileText(record.tag) ??
		profileText(record.m_strPlayerName) ??
		profileText(persona?.personaName) ??
		profileText(persona?.name) ??
		profileText(persona?.m_strPlayerName);
	const avatarUrl =
		profileImageUrl(record.avatarUrl) ??
		profileImageUrl(record.avatar) ??
		profileImageUrl(record.avatar_url) ??
		profileImageUrl(record.image_url) ??
		profileImageUrl(record.image) ??
		profileImageUrl(record.icon) ??
		profileImageUrl(record.icon_url) ??
		profileImageUrl(record.m_avatarURL) ??
		profileImageUrl(persona?.avatarUrl) ??
		profileImageUrl(persona?.avatar) ??
		profileImageUrl(persona?.image_url) ??
		profileImageUrl(persona?.icon) ??
		avatarHashToUrl(record.avatarHash) ??
		avatarHashToUrl(record.avatar_hash) ??
		avatarHashToUrl(record.m_strAvatarHash) ??
		avatarHashToUrl(persona?.avatarHash) ??
		avatarHashToUrl(persona?.avatar_hash) ??
		avatarHashToUrl(persona?.m_strAvatarHash);

	if (!displayName && !avatarUrl) {
		return null;
	}

	return { displayName, avatarUrl };
};

const idsMatch = (candidateSteamId: string | undefined, expectedSteamId: string): boolean => {
	if (!candidateSteamId) {
		return false;
	}

	const candidate = candidateSteamId.replace(/^0+/, '') || '0';
	const expected = expectedSteamId.replace(/^0+/, '') || '0';
	return candidate === expected;
};

const firstMatchingFriendProfile = (source: RecordValue | undefined, expectedSteamId: string): FriendProfile | null => {
	if (!source) {
		return null;
	}

	const queue: Array<{ value: unknown; depth: number }> = [{ value: source, depth: 0 }];
	const visited = new Set<object>();

	while (queue.length > 0) {
		const next = queue.shift();
		if (!next) {
			break;
		}

		const { value, depth } = next;
		if (!value || typeof value !== 'object') {
			continue;
		}

		const objectValue = value as object;
		if (visited.has(objectValue)) {
			continue;
		}
		visited.add(objectValue);

		const record = asRecord(value);
		if (!record) {
			continue;
		}

		const loose = extractLooseFriendProfile(record);
		const persona = asRecord(record.persona);
		const candidateSteamId =
			asSteamIdStringFromUnknown(record.steamid) ??
			asSteamIdStringFromUnknown(record.steamId) ??
			asSteamIdStringFromUnknown(record.steam_id) ??
			asSteamIdStringFromUnknown(record.steamid64) ??
			asSteamIdStringFromUnknown(record.ulSteamID) ??
			asSteamIdStringFromUnknown(record.friend_steamid) ??
			asSteamIdStringFromUnknown(record.m_steamid) ??
			asSteamIdStringFromUnknown(persona?.steamid) ??
			asSteamIdStringFromUnknown(persona?.m_steamid);
		const isMatch = idsMatch(candidateSteamId, expectedSteamId);
		if (isMatch && loose) {
			return loose;
		}

		if (depth >= 2) {
			continue;
		}

		for (const nested of Object.values(record)) {
			if (nested && typeof nested === 'object') {
				queue.push({ value: nested, depth: depth + 1 });
			}
		}
	}

	return null;
};

const resolveFriendProfileFromStores = (steamId: string): FriendProfile | null => {
	const cached = resolvedFriendProfileCache.get(steamId);
	if (cached) {
		return cached;
	}

	const scopedWindow = getWindowObject();
	const directStoreKeys = [
		'FriendsStore',
		'FriendStore',
		'SteamFriendsStore',
		'g_FriendsStore',
		'g_FriendStore',
		'g_FriendsUIStore',
		'FriendsUIStore',
	];
	const directMethodNames = [
		'GetFriend',
		'GetFriendBySteamID',
		'GetFriendBySteamId',
		'GetPlayerBySteamID',
		'GetPersonaBySteamID',
		'GetUserBySteamID',
		'GetContactBySteamID',
	];

	const steamIdAsNumber = Number(steamId);
	const callArgs: unknown[] = Number.isFinite(steamIdAsNumber) ? [steamId, steamIdAsNumber] : [steamId];
	const inspectSource = (candidate: unknown): FriendProfile | null => firstMatchingFriendProfile(asRecord(candidate), steamId);
	const inspectDirectResult = (candidate: unknown): FriendProfile | null =>
		inspectSource(candidate) ??
		extractLooseFriendProfile(asRecord(candidate)) ??
		null;
	const inspectGraphBySteamId = (root: unknown): FriendProfile | null => {
		if (!root || (typeof root !== 'object' && typeof root !== 'function')) {
			return null;
		}

		const queue: Array<{ value: unknown; depth: number }> = [{ value: root, depth: 0 }];
		const visited = new Set<object>();
		let inspected = 0;

		while (queue.length > 0 && inspected < 1200) {
			const next = queue.shift();
			if (!next) {
				break;
			}

			const { value, depth } = next;
			if (!value || typeof value !== 'object') {
				continue;
			}

			const objectValue = value as object;
			if (visited.has(objectValue)) {
				continue;
			}
			visited.add(objectValue);
			inspected += 1;

			if (value instanceof Map) {
				const direct = value.get(steamId) ?? value.get(Number(steamId));
				const directProfile = inspectDirectResult(direct);
				if (directProfile) {
					return directProfile;
				}

				let index = 0;
				for (const [key, mapValue] of value.entries()) {
					if (index >= 120) {
						break;
					}
					const keySteamId = asSteamIdStringFromUnknown(key);
					if (idsMatch(keySteamId, steamId)) {
						const keyedProfile = inspectDirectResult(mapValue);
						if (keyedProfile) {
							return keyedProfile;
						}
					}

					if (depth < 4 && mapValue && typeof mapValue === 'object') {
						queue.push({ value: mapValue, depth: depth + 1 });
					}
					index += 1;
				}
				continue;
			}

			const record = asRecord(value);
			if (!record) {
				continue;
			}

			const bySteamIdKey = record[steamId];
			const bySteamIdProfile = inspectDirectResult(bySteamIdKey);
			if (bySteamIdProfile) {
				return bySteamIdProfile;
			}

			const candidateSteamId =
				asSteamIdStringFromUnknown(record.steamid) ??
				asSteamIdStringFromUnknown(record.steamId) ??
				asSteamIdStringFromUnknown(record.steam_id) ??
				asSteamIdStringFromUnknown(record.steamid64) ??
				asSteamIdStringFromUnknown(record.ulSteamID) ??
				asSteamIdStringFromUnknown(record.friend_steamid) ??
				asSteamIdStringFromUnknown(record.m_steamid) ??
				asSteamIdStringFromUnknown(asRecord(record.persona)?.steamid) ??
				asSteamIdStringFromUnknown(asRecord(record.persona)?.m_steamid);
			if (idsMatch(candidateSteamId, steamId)) {
				const profile = extractLooseFriendProfile(record);
				if (profile) {
					return profile;
				}
			}

			if (depth >= 4) {
				continue;
			}

			let childCount = 0;
			for (const nested of Object.values(record)) {
				if (!nested || typeof nested !== 'object') {
					continue;
				}
				queue.push({ value: nested, depth: depth + 1 });
				childCount += 1;
				if (childCount >= 80) {
					break;
				}
			}
		}

		return null;
	};

	for (const storeKey of directStoreKeys) {
		const store = asRecord(scopedWindow[storeKey]);
		if (!store) {
			continue;
		}

		for (const methodName of directMethodNames) {
			const maybeMethod = store[methodName];
			if (typeof maybeMethod !== 'function') {
				continue;
			}

			for (const arg of callArgs) {
				try {
					const result = (maybeMethod as (id: unknown) => unknown).call(store, arg);
					const profile = inspectDirectResult(result);
					if (profile) {
						resolvedFriendProfileCache.set(steamId, profile);
						return profile;
					}
				} catch {
					// Ignore and continue probing compatible stores.
				}
			}
		}
	}

	const globalCandidates = [
		asRecord(scopedWindow.FriendsStore),
		asRecord(scopedWindow.FriendStore),
		asRecord(scopedWindow.SteamFriendsStore),
		asRecord(scopedWindow.g_FriendsStore),
		asRecord(scopedWindow.g_FriendStore),
		asRecord(scopedWindow.g_FriendsUIStore),
		asRecord(scopedWindow.FriendsUIStore),
		asRecord(scopedWindow.FriendStoreCache),
		asRecord(scopedWindow.NotificationStore),
	];
	for (const candidate of globalCandidates) {
		const profile = inspectSource(candidate);
		if (profile) {
			resolvedFriendProfileCache.set(steamId, profile);
			return profile;
		}
	}

	for (const candidate of globalCandidates) {
		const profile = inspectGraphBySteamId(candidate);
		if (profile) {
			resolvedFriendProfileCache.set(steamId, profile);
			return profile;
		}
	}

	const windowFriendishKeys = Object.keys(scopedWindow).filter((key) => /friend|chat|persona|contact/i.test(key)).slice(0, 60);
	for (const key of windowFriendishKeys) {
		const profile = inspectGraphBySteamId(scopedWindow[key]);
		if (profile) {
			resolvedFriendProfileCache.set(steamId, profile);
			return profile;
		}
	}

	return null;
};

const resolveFriendSteamId = (info: RecordValue | undefined, toastEnvelope: RecordValue | undefined, data: RecordValue): string | undefined => {
	const numericIdFields = ['steamid', 'steam_id', 'ulSteamID', 'sender_steamid', 'friend_steamid', 'friendid', 'friend_id', 'accountid', 'account_id'];
	const numericCandidates: unknown[] = [];
	for (const key of numericIdFields) {
		numericCandidates.push(data[key], toastEnvelope?.[key], info?.[key]);
	}

	if (Array.isArray(data.array)) {
		numericCandidates.push(data.array[0], data.array[1], data.array[5]);
	}

	for (const candidate of numericCandidates) {
		const id = asPositiveIntegerString(candidate);
		if (id) {
			return id;
		}
	}

	return undefined;
};

const resolveAppId = (info: RecordValue | undefined, toastEnvelope: RecordValue | undefined, data: RecordValue): string | undefined => {
	const fields = ['appid', 'app_id', 'gameid', 'game_id', 'nAppID', 'nGameID', 'dlc_appid', 'dlcAppId'];
	const candidates: unknown[] = [];
	for (const key of fields) {
		candidates.push(data[key], toastEnvelope?.[key], info?.[key]);
	}

	if (Array.isArray(data.array)) {
		candidates.push(data.array[0], data.array[1], data.array[2], data.array[3]);
	}

	for (const candidate of candidates) {
		const id = asPositiveIntegerString(candidate);
		if (id) {
			return id;
		}
	}

	return undefined;
};

const resolveAppProfileFromStores = (appId: string): AppProfile | null => {
	const cached = resolvedAppProfileCache.get(appId);
	if (cached) {
		return cached;
	}

	const scopedWindow = window as unknown as Record<string, unknown>;
	const appIdNumber = Number(appId);
	const searchKeys = [appId, appIdNumber];
	const pickNameFromRecord = (record: RecordValue | undefined): string | undefined =>
		firstNonGenericString(record, ['display_name', 'displayName', 'app_name', 'appName', 'name', 'title']) ??
		firstString(record, ['localized_name', 'localizedName']);

	const appStore = asRecord(scopedWindow.AppStore);
	if (appStore) {
		const appLookupFunctions = ['GetAppOverviewByAppID', 'GetAppByID', 'GetAppOverview', 'GetAppData', 'GetApp'];
		for (const fnName of appLookupFunctions) {
			const fn = appStore[fnName];
			if (typeof fn !== 'function') {
				continue;
			}
			for (const key of searchKeys) {
				try {
					const appRecord = asRecord((fn as (id: unknown) => unknown).call(appStore, key));
					const name = pickNameFromRecord(appRecord);
					if (name) {
						const profile: AppProfile = { name };
						resolvedAppProfileCache.set(appId, profile);
						return profile;
					}
				} catch {
					// Ignore lookup failures.
				}
			}
		}
	}

	const appInfo = asRecord(scopedWindow.g_rgAppInfo);
	if (appInfo) {
		const appRecord = asRecord(appInfo[appId] ?? appInfo[String(appIdNumber)]);
		const name = pickNameFromRecord(appRecord);
		if (name) {
			const profile: AppProfile = { name };
			resolvedAppProfileCache.set(appId, profile);
			return profile;
		}
	}

	return null;
};

const normalizeDisplayNameForLookup = (value: string | undefined): string =>
	normalizeWhitespace(value ?? '').toLowerCase();

const extractCandidateSteamIdFromRecord = (record: RecordValue): string | undefined => {
	const persona = asRecord(record.persona);
	return (
		asSteamIdStringFromUnknown(record.steamid) ??
		asSteamIdStringFromUnknown(record.steamId) ??
		asSteamIdStringFromUnknown(record.steam_id) ??
		asSteamIdStringFromUnknown(record.steamid64) ??
		asSteamIdStringFromUnknown(record.ulSteamID) ??
		asSteamIdStringFromUnknown(record.friend_steamid) ??
		asSteamIdStringFromUnknown(record.m_steamid) ??
		asSteamIdStringFromUnknown(persona?.steamid) ??
		asSteamIdStringFromUnknown(persona?.m_steamid)
	);
};

const resolveFriendSteamIdByDisplayName = (displayName: string | undefined): string | undefined => {
	const target = normalizeDisplayNameForLookup(displayName);
	if (!target) {
		return undefined;
	}

	for (const [steamId, profile] of resolvedFriendProfileCache.entries()) {
		if (normalizeDisplayNameForLookup(profile.displayName) === target) {
			return steamId;
		}
	}

	const scopedWindow = getWindowObject();
	const globalCandidates = [
		asRecord(scopedWindow.FriendsStore),
		asRecord(scopedWindow.FriendStore),
		asRecord(scopedWindow.SteamFriendsStore),
		asRecord(scopedWindow.g_FriendsStore),
		asRecord(scopedWindow.g_FriendStore),
		asRecord(scopedWindow.g_FriendsUIStore),
		asRecord(scopedWindow.FriendsUIStore),
		asRecord(scopedWindow.FriendStoreCache),
		asRecord(scopedWindow.NotificationStore),
	];

	for (const candidate of globalCandidates) {
		if (!candidate) {
			continue;
		}

		const queue: Array<{ value: unknown; depth: number }> = [{ value: candidate, depth: 0 }];
		const visited = new Set<object>();
		let inspected = 0;

		while (queue.length > 0 && inspected < 1200) {
			const next = queue.shift();
			if (!next) {
				break;
			}

			const { value, depth } = next;
			if (!value || typeof value !== 'object') {
				continue;
			}

			const objectValue = value as object;
			if (visited.has(objectValue)) {
				continue;
			}
			visited.add(objectValue);
			inspected += 1;

			if (value instanceof Map) {
				let index = 0;
				for (const [, mapValue] of value.entries()) {
					if (index >= 120) {
						break;
					}
					if (mapValue && typeof mapValue === 'object') {
						queue.push({ value: mapValue, depth: depth + 1 });
					}
					index += 1;
				}
				continue;
			}

			const record = asRecord(value);
			if (!record) {
				continue;
			}

			const profile = extractLooseFriendProfile(record);
			const candidateSteamId = extractCandidateSteamIdFromRecord(record);
			if (profile?.displayName && candidateSteamId && normalizeDisplayNameForLookup(profile.displayName) === target) {
				resolvedFriendProfileCache.set(candidateSteamId, profile);
				return candidateSteamId;
			}

			if (depth >= 4) {
				continue;
			}

			let childCount = 0;
			for (const nested of Object.values(record)) {
				if (!nested || typeof nested !== 'object') {
					continue;
				}
				queue.push({ value: nested, depth: depth + 1 });
				childCount += 1;
				if (childCount >= 80) {
					break;
				}
			}
		}
	}

	return undefined;
};

const resolveGroupSenderSteamId = (info: RecordValue | undefined, toastEnvelope: RecordValue | undefined, data: RecordValue): string | undefined => {
	const idFields = ['steamid_sender', 'sender_steamid', 'steamid', 'steam_id', 'ulSteamID'];
	const candidates: unknown[] = [];
	for (const key of idFields) {
		candidates.push(data[key], toastEnvelope?.[key], info?.[key]);
	}

	if (Array.isArray(data.array)) {
		candidates.push(data.array[2], data.array[3], data.array[4], data.array[5]);
	}

	for (const candidate of candidates) {
		const id = asPositiveIntegerString(candidate);
		if (id) {
			return id;
		}
	}

	return undefined;
};

const parseSteamIdFromFriendsUrl = (url: string | undefined): string | undefined => {
	const candidate = asString(url);
	if (!candidate) {
		return undefined;
	}

	const normalized = candidate.trim();
	const match = normalized.match(/^steam:\/\/friends\/(?:message|openchat|startchat)\/(\d{5,})/i);
	if (match) {
		return asPositiveIntegerString(match[1]);
	}

	const queryMatch = normalized.match(/[?&](?:steamid|steamid64|friendid)=(\d{5,})/i);
	if (queryMatch) {
		return asPositiveIntegerString(queryMatch[1]);
	}

	const profileMatch = normalized.match(/\/profiles\/(\d{5,})(?:[/?#]|$)/i);
	if (profileMatch) {
		return asPositiveIntegerString(profileMatch[1]);
	}

	return undefined;
};

const launchUrlPriority = (url: string): number => {
	const normalized = url.toLowerCase();
	if (/^steam:\/\/friends\/(?:message|openchat|startchat|joinchat)\/\d{5,}/i.test(normalized)) {
		return 100;
	}
	if (/^https?:\/\/steamcommunity\.com\/profiles\/\d{5,}/i.test(normalized)) {
		return 90;
	}
	if (/[?&](?:steamid|steamid64|friendid)=\d{5,}/i.test(normalized)) {
		return 80;
	}
	if (/^steam:\/\//i.test(normalized)) {
		return 40;
	}
	if (/^https?:\/\//i.test(normalized)) {
		return 20;
	}
	return 0;
};

const pickPreferredLaunchUrl = (urls: string[]): string | undefined => {
	let bestUrl: string | undefined;
	let bestPriority = -1;
	for (const url of urls) {
		const priority = launchUrlPriority(url);
		if (priority > bestPriority) {
			bestPriority = priority;
			bestUrl = url;
		}
	}
	return bestUrl;
};

const isUsefulVoiceTitle = (value: string | undefined): boolean => {
	const text = asString(value);
	if (!text) {
		return false;
	}

	return !isGenericIncomingVoiceText(text);
};

const defaultActionLabel = (typeId: number): string => DEFAULT_ACTION_LABEL_BY_TYPE.get(typeId) ?? 'Open';

const normalizeWhitespace = (value: string): string => value.replace(/\s+/g, ' ').trim();

const canonicalSenderIdentity = (value: string): string =>
	normalizeWhitespace(value)
		.toLowerCase()
		.replace(/[|!1l]/g, 'i')
		.replace(/[^a-z0-9]+/g, '');

const senderNamesEquivalent = (left: string, right: string): boolean => {
	const leftCompact = normalizeWhitespace(left).toLowerCase();
	const rightCompact = normalizeWhitespace(right).toLowerCase();
	if (!leftCompact || !rightCompact) {
		return false;
	}
	if (leftCompact === rightCompact) {
		return true;
	}

	const leftCanonical = canonicalSenderIdentity(leftCompact);
	const rightCanonical = canonicalSenderIdentity(rightCompact);
	return leftCanonical.length > 0 && leftCanonical === rightCanonical;
};

const collapseDuplicatedSenderLabel = (value: string | undefined): string | undefined => {
	const compact = asString(value);
	if (!compact) {
		return undefined;
	}

	const exactDuplicateMatch = normalizeWhitespace(compact).match(/^(.{2,80}?)\s+\1$/i);
	if (exactDuplicateMatch) {
		return normalizeWhitespace(exactDuplicateMatch[1]);
	}

	const parts = normalizeWhitespace(compact).split(' ').filter((part) => part.length > 0);
	if (parts.length >= 2 && parts.length % 2 === 0) {
		const half = parts.length / 2;
		const first = parts.slice(0, half).join(' ');
		const second = parts.slice(half).join(' ');
		if (senderNamesEquivalent(first, second)) {
			return normalizeWhitespace(first);
		}
	}

	return normalizeWhitespace(compact);
};

const truncateForLog = (value: string, maxLength = 96): string => {
	const compact = normalizeWhitespace(value);
	if (compact.length <= maxLength) {
		return compact;
	}

	return `${compact.slice(0, maxLength - 3)}...`;
};

const isGenericText = (value: string): boolean => {
	const normalized = normalizeWhitespace(value).toLowerCase();
	return normalized.length === 0 || GENERIC_TEXT_VALUES.has(normalized);
};

const hasMeaningfulText = (value: string): boolean => !isGenericText(value);

const isOverlayTutorialText = (value: string | undefined): boolean => {
	const normalized = normalizeWhitespace(value ?? '');
	if (!normalized) {
		return false;
	}

	return OVERLAY_TUTORIAL_PATTERNS.some((pattern) => pattern.test(normalized));
};

const payloadFingerprint = (payload: NativeToastPayload): string =>
	payload.typeId === EClientNotificationType.IncomingVoiceChat
		? [
				payload.typeId,
				normalizeWhitespace(payload.title),
				normalizeWhitespace(payload.body),
			].join('|')
		: payload.eventKey &&
			payload.eventKey.length > 0 &&
			payload.typeId !== EClientNotificationType.FriendMessage &&
			payload.typeId !== EClientNotificationType.GroupChatMessage
			? `event:${payload.eventKey}`
			: [
					payload.typeId,
					normalizeWhitespace(payload.title),
					normalizeWhitespace(payload.body),
					payload.launchUrl ?? '',
				].join('|');

const summarizePayload = (payload: NativeToastPayload): string =>
	`type=${payload.typeName} title="${truncateForLog(payload.title, 48)}" body="${truncateForLog(payload.body, 72)}"`;

const allocateDebugTraceId = (): string => {
	const trace = `t${Date.now()}_${nextDebugTraceSequence}`;
	nextDebugTraceSequence += 1;
	return trace;
};

const ensureDebugPayload = (payload: NativeToastPayload, source: string): NativeToastPayload => ({
	...payload,
	debugTraceId: payload.debugTraceId ?? allocateDebugTraceId(),
	debugSource: payload.debugSource ?? source,
});

const tracePipeline = (message: string): void => {
	void writeTraceLog({ message }).catch(() => {
		// Keep notification flow alive if tracing fails.
	});
};

const extractActions = (source: RecordValue | undefined, typeId: number): NativeToastAction[] => {
	if (!source || !Array.isArray(source.actions)) {
		return [];
	}

	const actions: NativeToastAction[] = [];

	for (const action of source.actions) {
		const record = asRecord(action);
		if (!record) {
			continue;
		}

		const label = firstString(record, ['content', 'label', 'title', 'text']) ?? defaultActionLabel(typeId);
		const url = sanitizeActionUrl(firstString(record, ['url', 'launchUrl', 'launchURL', 'arguments', 'response_steamurl']));
		if (!url) {
			continue;
		}

		actions.push({ label, url });
		if (actions.length >= 3) {
			break;
		}
	}

	return actions;
};

const extractActionsFromSources = (sources: Array<RecordValue | undefined>, typeId: number): NativeToastAction[] => {
	const deduped = new Map<string, NativeToastAction>();

	for (const source of sources) {
		for (const action of extractActions(source, typeId)) {
			const dedupeKey = `${action.label}\x1f${action.url}`;
			if (!deduped.has(dedupeKey)) {
				deduped.set(dedupeKey, action);
			}
		}
	}

	return [...deduped.values()];
};

const resolveTypeName = (typeId: number): string => {
	const typeName = EClientNotificationType[typeId as EClientNotificationType];
	return typeof typeName === 'string' ? typeName : 'General';
};

const normalizeSteamMessageText = (value: string | undefined): string | undefined => {
	const text = asString(value);
	if (!text) {
		return undefined;
	}

	let normalized = normalizeWhitespace(text);
	normalized = normalized.replace(/\[(?:emoticon|sticker)\s+name=(["']?)([a-z0-9_.-]+)\1\]/gi, ':$2:');
	normalized = normalized.replace(/<emoji[^>]*name=(["'])([a-z0-9_.-]+)\1[^>]*>/gi, ':$2:');
	normalized = normalized.replace(/[\u02d0:：]([a-z0-9_.-]+)[\u02d0:：]/gi, ':$1:');
	normalized = normalizeWhitespace(normalized);
	return normalized.length > 0 ? normalized : undefined;
};

const extractChatPayloadFromArray = (
	typeId: number,
	data: RecordValue
): Pick<NativeToastPayload, 'title' | 'body' | 'icon'> | null => {
	if (typeId !== EClientNotificationType.FriendMessage || !Array.isArray(data.array)) {
		return null;
	}

	const sender = asString(data.array[2]);
	const message =
		normalizeSteamMessageText(asString(data.array[3])) ??
		normalizeSteamMessageText(firstString(data, ['message_no_bbcode', 'message', 'rawbody', 'body', 'description', 'subtext']));
	const icon = asString(data.array[4]);
	if (!sender || !message) {
		return null;
	}

	return {
		title: sender,
		body: message,
		icon: icon && /^https?:\/\//i.test(icon) ? icon : undefined,
	};
};

const isLikelyNumericIdentifierText = (value: string | undefined): boolean => {
	const text = asString(value);
	if (!text) {
		return false;
	}

	return /^\d{6,}$/.test(text.trim());
};

const extractGroupChatPayload = (
	typeId: number,
	info: RecordValue | undefined,
	toastEnvelope: RecordValue | undefined,
	data: RecordValue
): Pick<NativeToastPayload, 'title' | 'body' | 'icon'> | null => {
	if (typeId !== EClientNotificationType.GroupChatMessage) {
		return null;
	}

	const groupName =
		firstNonGenericString(data, ['chat_name', 'chatName', 'title', 'name', 'tag', 'chat_group_name', 'group_name']) ??
		firstNonGenericString(toastEnvelope, ['chat_name', 'chatName', 'title', 'name', 'tag', 'chat_group_name', 'group_name']) ??
		firstNonGenericString(info, ['chat_name', 'chatName', 'title', 'name', 'tag', 'chat_group_name', 'group_name']);
	const senderSteamId = resolveGroupSenderSteamId(info, toastEnvelope, data);
	const senderProfile = senderSteamId ? resolveFriendProfileFromStores(senderSteamId) : null;
	const sender =
		senderProfile?.displayName ??
		firstNonGenericString(data, ['sender_name', 'senderName', 'personaName']) ??
		firstNonGenericString(toastEnvelope, ['sender_name', 'senderName', 'personaName']) ??
		firstNonGenericString(info, ['sender_name', 'senderName', 'personaName']);
	const message =
		firstString(data, ['message_no_bbcode', 'message', 'rawbody', 'body', 'description', 'subtext']) ??
		firstString(toastEnvelope, ['message_no_bbcode', 'message', 'rawbody', 'body', 'description', 'subtext']) ??
		firstString(info, ['message_no_bbcode', 'message', 'rawbody', 'body', 'description', 'subtext']);
	const arraySender = Array.isArray(data.array) ? asString(data.array[2]) : undefined;
	const arrayMessage = Array.isArray(data.array) ? asString(data.array[3]) : undefined;
	const arrayTextCandidates = Array.isArray(data.array)
		? data.array
				.map((entry) => asString(entry))
				.filter((entry): entry is string => !!entry)
				.filter((entry) => !/^(steam|https?):\/\//i.test(entry))
		: [];
	const arrayHumanText = arrayTextCandidates.filter((entry) => !isLikelyNumericIdentifierText(entry));
	const inferredGroupName = groupName ?? arrayHumanText[0];
	const inferredSender = sender ?? arraySender ?? arrayHumanText[1];
	const inferredMessage = message ?? arrayMessage ?? arrayHumanText[2];
	const splitSenderAndMessage = (() => {
		const candidate = asString(inferredMessage);
		if (!candidate) {
			return null;
		}
		const match = normalizeWhitespace(candidate).match(/^([^:]{2,80})\s*:\s*(.+)$/);
		if (!match) {
			return null;
		}
		const parsedSender = normalizeWhitespace(match[1]);
		const parsedMessage = normalizeWhitespace(match[2]);
		if (!parsedSender || !parsedMessage) {
			return null;
		}
		return { parsedSender, parsedMessage };
	})();
	const finalSender = (() => {
		if (splitSenderAndMessage && !isLikelyNumericIdentifierText(splitSenderAndMessage.parsedSender)) {
			return collapseDuplicatedSenderLabel(splitSenderAndMessage.parsedSender);
		}
		const preferredSender = asString(senderProfile?.displayName) ?? inferredSender;
		return collapseDuplicatedSenderLabel(preferredSender);
	})();
	const finalMessage = splitSenderAndMessage?.parsedMessage ?? inferredMessage;
	const dedupedMessage = (() => {
		const senderText = asString(finalSender);
		const messageText = asString(finalMessage);
		if (!senderText || !messageText) {
			return messageText;
		}

		const compactSender = normalizeWhitespace(senderText);
		const compactMessage = normalizeWhitespace(messageText);
		const compactSenderLower = compactSender.toLowerCase();
		const compactMessageLower = compactMessage.toLowerCase();

		if (compactMessageLower.startsWith(`${compactSenderLower}:`)) {
			const stripped = compactMessage.slice(compactSender.length + 1).trim();
			return stripped.length > 0 ? stripped : compactMessage;
		}

		const senderPrefixedMatch = compactMessage.match(/^([^:]{2,80})\s*:\s*(.+)$/);
		if (senderPrefixedMatch && senderNamesEquivalent(senderPrefixedMatch[1], compactSender)) {
			const stripped = normalizeWhitespace(senderPrefixedMatch[2]);
			return stripped.length > 0 ? stripped : compactMessage;
		}

		return compactMessage;
	})();
	const icon = preferredAvatarUrl(
		senderProfile?.avatarUrl,
		profileImageUrl(firstString(data, ['icon', 'image_url', 'image', 'icon_url'])),
		profileImageUrl(firstString(toastEnvelope, ['icon', 'image_url', 'image', 'icon_url'])),
		profileImageUrl(firstString(info, ['icon', 'image_url', 'image', 'icon_url']))
	);

	if (!inferredGroupName || !finalSender || !dedupedMessage) {
		return null;
	}
	if (
		isLikelyNumericIdentifierText(inferredGroupName) ||
		isLikelyNumericIdentifierText(finalSender) ||
		isLikelyNumericIdentifierText(dedupedMessage)
	) {
		return null;
	}

	const voiceInviteMatch = normalizeWhitespace(dedupedMessage).match(
		/^(?:(.{2,80}?)\s+)?invited you to voice chat in(?:\s+"(.*)")?$/i
	);
	if (voiceInviteMatch) {
		const parsedInviter = asString(voiceInviteMatch[1]);
		const inviter = parsedInviter ?? finalSender;
		const voiceNameRaw = typeof voiceInviteMatch[2] === 'string' ? voiceInviteMatch[2] : '';
		const voiceName = normalizeVoiceChannelName(voiceNameRaw);
		return {
			title: inviter,
			body: `invited you to voice chat in "${voiceName}"`,
			icon,
		};
	}

	return {
		title: inferredGroupName,
		body: `${finalSender}: "${dedupedMessage}"`,
		icon,
	};
};

const extractIncomingVoiceChatPayload = (
	typeId: number,
	info: RecordValue | undefined,
	toastEnvelope: RecordValue | undefined,
	data: RecordValue
): Pick<NativeToastPayload, 'title' | 'body' | 'icon'> | null => {
	if (typeId !== EClientNotificationType.IncomingVoiceChat) {
		return null;
	}

	const steamId = resolveFriendSteamId(info, toastEnvelope, data);
	const profile = steamId ? resolveFriendProfileFromStores(steamId) : null;
	const fallbackName =
		firstNonGenericString(data, ['personaName', 'displayName', 'sender_name', 'senderName', 'friend_name', 'caller_name', 'title', 'name', 'tag']) ??
		firstNonGenericString(toastEnvelope, ['personaName', 'displayName', 'sender_name', 'senderName', 'friend_name', 'caller_name', 'title', 'name', 'tag']) ??
		firstNonGenericString(info, ['personaName', 'displayName', 'sender_name', 'senderName', 'friend_name', 'caller_name', 'title', 'name', 'tag']) ??
		(Array.isArray(data.array)
			? [data.array[2], data.array[3], data.array[4]]
					.map((entry) => asString(entry))
					.find((entry) => !!entry && !isGenericIncomingVoiceText(entry))
			: undefined);
	const friendName = profile?.displayName ?? fallbackName;
	const icon = preferredAvatarUrl(
		profile?.avatarUrl,
		profileImageUrl(firstString(data, ['icon', 'image_url', 'image', 'icon_url'])),
		profileImageUrl(firstString(toastEnvelope, ['icon', 'image_url', 'image', 'icon_url'])),
		profileImageUrl(firstString(info, ['icon', 'image_url', 'image', 'icon_url']))
	);

	return {
		title: friendName ?? 'Steam',
		body: friendName
			? `${friendName} has opened voice chat and is waiting on you.`
			: 'A friend has opened voice chat and is waiting on you.',
		icon,
	};
};

const extractFriendOnlinePayload = (
	typeId: number,
	info: RecordValue | undefined,
	toastEnvelope: RecordValue | undefined,
	data: RecordValue
): Pick<NativeToastPayload, 'title' | 'body' | 'icon'> | null => {
	if (typeId !== EClientNotificationType.FriendOnline) {
		return null;
	}

	const steamId = resolveFriendSteamId(info, toastEnvelope, data);
	const profile = steamId ? resolveFriendProfileFromStores(steamId) : null;
	const fallbackName =
		firstNonGenericString(data, ['personaName', 'displayName', 'sender_name', 'senderName', 'friend_name', 'title', 'name', 'tag']) ??
		firstNonGenericString(toastEnvelope, ['personaName', 'displayName', 'sender_name', 'senderName', 'friend_name', 'title', 'name', 'tag']) ??
		firstNonGenericString(info, ['personaName', 'displayName', 'sender_name', 'senderName', 'friend_name', 'title', 'name', 'tag']) ??
		(Array.isArray(data.array)
			? [data.array[1], data.array[2], data.array[3]]
					.map((entry) => asString(entry))
					.find((entry) => !!entry && !isGenericIncomingVoiceText(entry))
			: undefined);
	const friendName = profile?.displayName ?? fallbackName;
	const icon = preferredAvatarUrl(
		profile?.avatarUrl,
		profileImageUrl(firstString(data, ['icon', 'image_url', 'image', 'icon_url'])),
		profileImageUrl(firstString(toastEnvelope, ['icon', 'image_url', 'image', 'icon_url'])),
		profileImageUrl(firstString(info, ['icon', 'image_url', 'image', 'icon_url']))
	);

	if (!friendName) {
		return null;
	}

	return {
		title: 'Friend',
		body: `${friendName} is now online`,
		icon,
	};
};

const extractFriendInGamePayload = (
	typeId: number,
	info: RecordValue | undefined,
	toastEnvelope: RecordValue | undefined,
	data: RecordValue
): Pick<NativeToastPayload, 'title' | 'body' | 'icon'> | null => {
	if (typeId !== EClientNotificationType.FriendInGame) {
		return null;
	}

	const steamId = resolveFriendSteamId(info, toastEnvelope, data);
	const profile = steamId ? resolveFriendProfileFromStores(steamId) : null;
	const friendName =
		profile?.displayName ??
		firstNonGenericString(data, ['personaName', 'displayName', 'sender_name', 'senderName', 'friend_name', 'title', 'name', 'tag']) ??
		firstNonGenericString(toastEnvelope, ['personaName', 'displayName', 'sender_name', 'senderName', 'friend_name', 'title', 'name', 'tag']) ??
		firstNonGenericString(info, ['personaName', 'displayName', 'sender_name', 'senderName', 'friend_name', 'title', 'name', 'tag']);
	const gameName =
		firstNonGenericString(data, ['game_name']) ??
		firstNonGenericString(toastEnvelope, ['game_name']) ??
		firstNonGenericString(info, ['game_name']);
	const icon = preferredAvatarUrl(
		profile?.avatarUrl,
		profileImageUrl(firstString(data, ['icon', 'image_url', 'image', 'icon_url'])),
		profileImageUrl(firstString(toastEnvelope, ['icon', 'image_url', 'image', 'icon_url'])),
		profileImageUrl(firstString(info, ['icon', 'image_url', 'image', 'icon_url']))
	);

	if (!friendName || !gameName) {
		return null;
	}

	return {
		title: friendName,
		body: `${friendName} invited you to play ${gameName}.`,
		icon,
	};
};

const extractDownloadCompletePayload = (
	typeId: number,
	info: RecordValue | undefined,
	toastEnvelope: RecordValue | undefined,
	data: RecordValue
): Pick<NativeToastPayload, 'title' | 'body'> | null => {
	if (typeId !== EClientNotificationType.DownloadComplete) {
		return null;
	}

	const appId = resolveAppId(info, toastEnvelope, data);
	const appProfile = appId ? resolveAppProfileFromStores(appId) : null;
	const bodyCandidate =
		firstString(data, ['body', 'rawbody', 'description', 'subtext']) ??
		firstString(toastEnvelope, ['body', 'rawbody', 'description', 'subtext']) ??
		firstString(info, ['body', 'rawbody', 'description', 'subtext']);
	const appNameFromBody = (() => {
		const normalizedBody = normalizeWhitespace(bodyCandidate ?? '');
		if (!normalizedBody || normalizedBody.toLowerCase() === 'downloadcomplete') {
			return undefined;
		}
		const readyMatch = normalizedBody.match(/^(.{2,120}?)\s+(?:is|are)\s+ready to play\.?$/i);
		if (readyMatch) {
			return stripQuotedEdges(readyMatch[1]);
		}
		return undefined;
	})();
	const appName =
		appProfile?.name ??
		appNameFromBody ??
		firstNonGenericString(data, ['game_name', 'app_name', 'appName', 'name', 'title']) ??
		firstNonGenericString(toastEnvelope, ['game_name', 'app_name', 'appName', 'name', 'title']) ??
		firstNonGenericString(info, ['game_name', 'app_name', 'appName', 'name', 'title']);

	return {
		title: 'Download Complete',
		body: appName ? `Your game "${appName}" is ready to play` : 'Your game is ready to play',
	};
};

const resolveStructuredLaunchUrl = (typeId: number, info: RecordValue | undefined, toastEnvelope: RecordValue | undefined, data: RecordValue): string | undefined => {
	const urlFields = [
		'launchUrl',
		'launchURL',
		'response_steamurl',
		'responseSteamUrl',
		'steamurl',
		'steam_url',
		'url',
		'targetUrl',
		'target_url',
		'link',
		'deepLink',
		'deeplink',
	];

	const directCandidates: string[] = [];
	const pushIfString = (value: unknown): void => {
		const stringValue = asString(value);
		if (stringValue) {
			directCandidates.push(stringValue);
		}
	};

	for (const key of urlFields) {
		pushIfString(data[key]);
		pushIfString(toastEnvelope?.[key]);
		pushIfString(info?.[key]);
	}

	for (const candidate of directCandidates) {
		const sanitized = sanitizeActionUrl(candidate);
		if (sanitized) {
			return sanitized;
		}
	}

	if (typeId === EClientNotificationType.DownloadComplete) {
		const appId = resolveAppId(info, toastEnvelope, data);
		if (appId) {
			return `steam://run/${appId}`;
		}
	}

	if (typeId === EClientNotificationType.FriendInGame) {
		return undefined;
	}

	if (!MESSAGE_NOTIFICATION_TYPES.has(typeId)) {
		return undefined;
	}

	const numericIdFields =
		typeId === EClientNotificationType.GroupChatMessage
			? ['chatid', 'chat_id', 'groupid', 'group_id', 'chat_group_id', 'conversationid', 'conversation_id']
			: ['steamid', 'steam_id', 'ulSteamID', 'sender_steamid', 'friend_steamid', 'friendid', 'friend_id', 'accountid', 'account_id'];

	const numericCandidates: unknown[] = [];
	for (const key of numericIdFields) {
		numericCandidates.push(data[key], toastEnvelope?.[key], info?.[key]);
	}

	if (Array.isArray(data.array)) {
		numericCandidates.push(data.array[0], data.array[1], data.array[5]);
	}

	for (const candidate of numericCandidates) {
		const id = asPositiveIntegerString(candidate);
		if (!id) {
			continue;
		}

		if (typeId === EClientNotificationType.GroupChatMessage) {
			return `steam://friends/joinchat/${id}`;
		}

		if (typeId === EClientNotificationType.FriendOnline) {
			return `steam://friends/message/${id}`;
		}

		return `steam://friends/message/${id}`;
	}

	return undefined;
};

const resolveEventKey = (typeId: number, info: RecordValue | undefined, toastEnvelope: RecordValue | undefined, data: RecordValue): string | undefined => {
	const numericLike = (value: unknown): string | undefined => {
		if (typeof value === 'number' && Number.isFinite(value)) {
			return String(Math.trunc(value));
		}
		if (typeof value === 'string' && value.trim().length > 0) {
			const compact = value.trim();
			if (/^\d+$/.test(compact)) {
				return compact;
			}
		}
		return undefined;
	};

	const idCandidate =
		numericLike(firstValue(toastEnvelope, ['nNotificationID', 'notificationid', 'notificationId', 'id', 'ulNotificationID'])) ??
		numericLike(firstValue(data, ['nNotificationID', 'notificationid', 'notificationId', 'id', 'ulNotificationID'])) ??
		numericLike(firstValue(info, ['nNotificationID', 'notificationid', 'notificationId', 'id', 'ulNotificationID']));

	const createdCandidate =
		numericLike(firstValue(toastEnvelope, ['rtCreated', 'timestamp', 'time', 'created', 'createdAt'])) ??
		numericLike(firstValue(data, ['rtCreated', 'timestamp', 'time', 'created', 'createdAt'])) ??
		numericLike(firstValue(info, ['rtCreated', 'timestamp', 'time', 'created', 'createdAt']));

	if (!idCandidate && !createdCandidate) {
		return undefined;
	}

	return `${typeId}|${idCandidate ?? ''}|${createdCandidate ?? ''}`;
};

const normalizeTimestampMs = (value: unknown): number | undefined => {
	if (typeof value === 'number' && Number.isFinite(value) && value > 0) {
		if (value > 1e12) {
			return Math.trunc(value);
		}
		if (value > 1e9) {
			return Math.trunc(value * 1000);
		}
	}

	if (typeof value === 'string') {
		const trimmed = value.trim();
		if (trimmed.length === 0) {
			return undefined;
		}

		const numeric = Number(trimmed);
		if (Number.isFinite(numeric)) {
			return normalizeTimestampMs(numeric);
		}

		const parsed = Date.parse(trimmed);
		if (Number.isFinite(parsed) && parsed > 0) {
			return Math.trunc(parsed);
		}
	}

	return undefined;
};

const resolveEventTimestampMs = (
	info: RecordValue | undefined,
	toastEnvelope: RecordValue | undefined,
	data: RecordValue
): number | undefined => {
	const candidates: unknown[] = [
		firstValue(toastEnvelope, ['rtCreated', 'timestamp', 'time', 'created', 'createdAt']),
		firstValue(data, ['rtCreated', 'timestamp', 'time', 'created', 'createdAt']),
		firstValue(info, ['rtCreated', 'timestamp', 'time', 'created', 'createdAt']),
	];

	for (const candidate of candidates) {
		const normalized = normalizeTimestampMs(candidate);
		if (normalized) {
			return normalized;
		}
	}

	return undefined;
};

const buildStructuredPayload = (info: RecordValue | undefined, toastEnvelope: RecordValue | undefined): NativeToastPayload | null => {
	if (toastEnvelope?.millennium === true) {
		return null;
	}

	const data = asRecord(toastEnvelope?.data) ?? asRecord(info?.data);
	if (!data) {
		return null;
	}

	const typeId =
		asNumber(toastEnvelope?.eType) ??
		asNumber(data.eType) ??
		asNumber(data.type) ??
		EClientNotificationType.General;
	const typeName = resolveTypeName(typeId);
	const chatPayload = extractChatPayloadFromArray(typeId, data);
	const groupPayload = extractGroupChatPayload(typeId, info, toastEnvelope, data);
	const voicePayload = extractIncomingVoiceChatPayload(typeId, info, toastEnvelope, data);
	const friendOnlinePayload = extractFriendOnlinePayload(typeId, info, toastEnvelope, data);
	const friendInGamePayload = extractFriendInGamePayload(typeId, info, toastEnvelope, data);
	const downloadCompletePayload = extractDownloadCompletePayload(typeId, info, toastEnvelope, data);
	let title =
		downloadCompletePayload?.title ??
		friendInGamePayload?.title ??
		friendOnlinePayload?.title ??
		voicePayload?.title ??
		groupPayload?.title ??
		chatPayload?.title ??
		firstString(data, ['title', 'name', 'tag']) ??
		`Steam: ${typeName}`;
	let body =
		downloadCompletePayload?.body ??
		friendInGamePayload?.body ??
		friendOnlinePayload?.body ??
		voicePayload?.body ??
		groupPayload?.body ??
		chatPayload?.body ??
		firstString(data, ['body', 'rawbody', 'description', 'subtext']) ??
		typeName;
	const icon =
		friendInGamePayload?.icon ??
		friendOnlinePayload?.icon ??
		voicePayload?.icon ??
		groupPayload?.icon ??
		chatPayload?.icon ??
		firstString(data, ['icon', 'image_url', 'image', 'icon_url']);
	const launchUrl = resolveStructuredLaunchUrl(typeId, info, toastEnvelope, data);

	if (typeId === EClientNotificationType.GroupChatMessage) {
		const groupFallbackTitle =
			firstNonGenericString(data, ['title', 'name', 'tag', 'chat_group_name', 'group_name']) ??
			firstNonGenericString(toastEnvelope, ['title', 'name', 'tag', 'chat_group_name', 'group_name']) ??
			firstNonGenericString(info, ['title', 'name', 'tag', 'chat_group_name', 'group_name']);
		const groupFallbackSender =
			firstNonGenericString(data, ['sender_name', 'senderName', 'name', 'personaName']) ??
			firstNonGenericString(toastEnvelope, ['sender_name', 'senderName', 'name', 'personaName']) ??
			firstNonGenericString(info, ['sender_name', 'senderName', 'name', 'personaName']);
		const groupFallbackMessage =
			firstString(data, ['body', 'rawbody', 'description', 'subtext']) ??
			firstString(toastEnvelope, ['body', 'rawbody', 'description', 'subtext']) ??
			firstString(info, ['body', 'rawbody', 'description', 'subtext']);

		if (groupFallbackTitle && !isLikelyNumericIdentifierText(groupFallbackTitle)) {
			title = groupFallbackTitle;
		} else if (!hasMeaningfulText(title) || isLikelyNumericIdentifierText(title)) {
			title = 'Group Chat';
		}

		if (
			groupFallbackSender &&
			groupFallbackMessage &&
			!isLikelyNumericIdentifierText(groupFallbackSender) &&
			!isLikelyNumericIdentifierText(groupFallbackMessage)
		) {
			const normalizedSender = collapseDuplicatedSenderLabel(groupFallbackSender) ?? groupFallbackSender;
			const normalizedMessage = removeEquivalentSenderPrefix(stripQuotedEdges(groupFallbackMessage), normalizedSender);
			body = `${normalizedSender}: "${normalizedMessage}"`;
		} else if (!hasMeaningfulText(body) || isLikelyNumericIdentifierText(body) || normalizeWhitespace(body).toLowerCase() === 'groupchatmessage') {
			body = 'New group message.';
		}
	}

	if (typeId === EClientNotificationType.FriendMessage) {
		const normalizedFriendBody = normalizeSteamMessageText(body);
		if (normalizedFriendBody) {
			body = normalizedFriendBody;
		}
	}

	let actions = extractActionsFromSources(
		[
			data,
			asRecord(info?.data),
			asRecord(toastEnvelope?.data),
			info,
			toastEnvelope,
		],
		typeId
	);
	if (typeId === EClientNotificationType.FriendOnline) {
		actions = [];
	}
	if (typeId === EClientNotificationType.DownloadComplete) {
		actions = [];
	}
	if (typeId !== EClientNotificationType.FriendOnline && actions.length === 0 && launchUrl) {
		actions = [{ label: defaultActionLabel(typeId), url: launchUrl }];
	}
	if (typeId === EClientNotificationType.DownloadComplete) {
		actions = [];
	}

	const payload: NativeToastPayload = {
		typeId,
		typeName,
		title,
		body,
		playSound: true,
	};

	if (icon) {
		payload.icon = icon;
	}

	if (launchUrl) {
		payload.launchUrl = launchUrl;
	}

	if (actions.length > 0) {
		payload.actions = actions;
	}

	const eventKey = resolveEventKey(typeId, info, toastEnvelope, data);
	if (eventKey) {
		payload.eventKey = eventKey;
	}

	const eventTimestampMs = resolveEventTimestampMs(info, toastEnvelope, data);
	if (eventTimestampMs) {
		payload.eventTimestampMs = eventTimestampMs;
	}

	if (typeId === EClientNotificationType.IncomingVoiceChat) {
		const incomingVoiceSteamId = resolveFriendSteamId(info, toastEnvelope, data);
		if (incomingVoiceSteamId) {
			payload.friendSteamId = incomingVoiceSteamId;
		}
	}

	if (typeId === EClientNotificationType.FriendMessage) {
		const friendMessageSteamId = resolveFriendSteamId(info, toastEnvelope, data);
		if (friendMessageSteamId) {
			payload.friendSteamId = friendMessageSteamId;
		}
	}

	if (typeId === EClientNotificationType.FriendInGame) {
		const friendInGameSteamId = resolveFriendSteamId(info, toastEnvelope, data);
		if (friendInGameSteamId) {
			payload.friendSteamId = friendInGameSteamId;
		}
	}

	if (typeId === EClientNotificationType.FriendOnline) {
		const friendOnlineSteamId = resolveFriendSteamId(info, toastEnvelope, data);
		if (friendOnlineSteamId) {
			payload.friendSteamId = friendOnlineSteamId;
		}
	}

	return payload;
};

const buildDirectProtoPayload = (record: RecordValue): NativeToastPayload | null => {
	const directFriendSteamId = asPositiveIntegerString(firstValue(record, ['steamid']));
	const directGroupSenderSteamId = asPositiveIntegerString(firstValue(record, ['steamid_sender']));

	if (directGroupSenderSteamId) {
		const senderProfile = resolveFriendProfileFromStores(directGroupSenderSteamId);
		const groupTitle =
			firstNonGenericString(record, ['title', 'tag']) ??
			'Group Chat';
		const groupBody =
			normalizeSteamMessageText(firstString(record, ['rawbody', 'body'])) ??
			firstString(record, ['rawbody', 'body']);
		const groupIcon = preferredAvatarUrl(
			senderProfile?.avatarUrl,
			profileImageUrl(firstString(record, ['icon']))
		);
		const chatGroupId = asPositiveIntegerString(firstValue(record, ['chat_group_id', 'chat_id']));
		if (!hasMeaningfulText(groupTitle) || !groupBody) {
			return null;
		}

		const payload: NativeToastPayload = {
			typeId: EClientNotificationType.GroupChatMessage,
			typeName: 'GroupChatMessage',
			title: groupTitle,
			body: groupBody,
			playSound: true,
			friendSteamId: directGroupSenderSteamId,
		};
		if (groupIcon) {
			payload.icon = groupIcon;
		}
		if (chatGroupId) {
			payload.launchUrl = `steam://friends/joinchat/${chatGroupId}`;
			payload.actions = [{ label: 'Open Chat', url: payload.launchUrl }];
		}
		return payload;
	}

	if (directFriendSteamId) {
		const directGameName = firstNonGenericString(record, ['game_name']);
		if (directGameName) {
			const directProfile = resolveFriendProfileFromStores(directFriendSteamId);
			const directFriendName =
				asString(directProfile?.displayName) ??
				firstNonGenericString(record, ['title', 'tag']) ??
				'Friend';
			const directIcon = preferredAvatarUrl(
				directProfile?.avatarUrl,
				profileImageUrl(firstString(record, ['icon']))
			);
			const payload: NativeToastPayload = {
				typeId: EClientNotificationType.FriendInGame,
				typeName: 'FriendInGame',
				title: directFriendName,
				body: `${directFriendName} invited you to play ${directGameName}.`,
				playSound: true,
				friendSteamId: directFriendSteamId,
			};
			if (directIcon) {
				payload.icon = directIcon;
			}
			return payload;
		}

		const responseUrl = sanitizeActionUrl(firstString(record, ['response_steamurl']));
		const directProfile = resolveFriendProfileFromStores(directFriendSteamId);
		const directBody =
			normalizeSteamMessageText(firstString(record, ['body', 'rawbody'])) ??
			firstString(record, ['body', 'rawbody']);
		const directTitle =
			firstNonGenericString(record, ['title', 'tag']) ??
			directProfile?.displayName;
		const directIcon = preferredAvatarUrl(
			directProfile?.avatarUrl,
			profileImageUrl(firstString(record, ['icon']))
		);
		if (!directBody || !directTitle) {
			return null;
		}

		const payload: NativeToastPayload = {
			typeId: EClientNotificationType.FriendMessage,
			typeName: 'FriendMessage',
			title: directTitle,
			body: directBody,
			playSound: true,
			friendSteamId: directFriendSteamId,
		};
		payload.launchUrl = responseUrl ?? `steam://friends/message/${directFriendSteamId}`;
		payload.actions = [{ label: 'Open Chat', url: payload.launchUrl }];
		if (directIcon) {
			payload.icon = directIcon;
		}
		return payload;
	}

	return null;
};

const buildStructuredPayloadFromRecord = (record: RecordValue): NativeToastPayload | null => {
	const directProtoPayload = buildDirectProtoPayload(record);
	if (directProtoPayload) {
		return directProtoPayload;
	}

	const directPayload = buildStructuredPayload(undefined, record);
	if (directPayload) {
		return directPayload;
	}

	const info = asRecord(record.info) ?? asRecord(record.notificationInfo) ?? asRecord(record.notification);
	const envelope =
		asRecord(record.toastEnvelope) ??
		asRecord(record.envelope) ??
		asRecord(record.toast) ??
		asRecord(record.popupToast) ??
		asRecord(record.item);
	if (envelope) {
		const payload = buildStructuredPayload(info, envelope);
		if (payload) {
			return payload;
		}
	}

	const nestedCandidates = [
		asRecord(record.notification),
		asRecord(record.toastEnvelope),
		asRecord(record.envelope),
		asRecord(record.toast),
		asRecord(record.item),
	];
	for (const nested of nestedCandidates) {
		if (!nested) {
			continue;
		}

		const payload = buildStructuredPayload(undefined, nested);
		if (payload) {
			return payload;
		}
	}

	return null;
};

const cleanupCaches = (now = Date.now()): void => {
	for (let index = recentStructuredNotifications.length - 1; index >= 0; index -= 1) {
		if (now - recentStructuredNotifications[index].capturedAt > STRUCTURED_CANDIDATE_TTL_MS) {
			recentStructuredNotifications.splice(index, 1);
		}
	}

	for (const [fingerprint, timestamp] of structuredFingerprintTimes.entries()) {
		if (now - timestamp > STRUCTURED_CANDIDATE_TTL_MS) {
			structuredFingerprintTimes.delete(fingerprint);
		}
	}

	for (const [eventKey, timestamp] of structuredEventKeyTimes.entries()) {
		if (now - timestamp > STRUCTURED_EVENT_KEY_TTL_MS) {
			structuredEventKeyTimes.delete(eventKey);
		}
	}

	for (const [signature, timestamp] of recentlyForwarded.entries()) {
		if (now - timestamp > FORWARDED_SIGNATURE_TTL_MS) {
			recentlyForwarded.delete(signature);
		}
	}
};

const shouldUseEventKeyCache = (payload: NativeToastPayload): boolean =>
	payload.typeId !== EClientNotificationType.FriendMessage &&
	payload.typeId !== EClientNotificationType.GroupChatMessage;

// We keep a short structured cache so popup handling can borrow Steam's
// richer metadata without letting multiple sources send the same toast.
// Chat is deliberately excluded from event-key dedupe because Steam can reuse
// weak keys while the visible popup text is the only fresh message evidence.
const captureStructuredNotificationsFromRoot = (root: unknown, source: string): void => {
	if (!root || typeof root !== 'object') {
		return;
	}

	const queue: Array<{ value: unknown; depth: number }> = [{ value: root, depth: 0 }];
	const visited = new Set<object>();
	let inspected = 0;
	const now = Date.now();

	while (queue.length > 0 && inspected < 400) {
		const next = queue.shift();
		if (!next) {
			break;
		}

		const { value, depth } = next;
		if (!value || typeof value !== 'object') {
			continue;
		}

		const objectValue = value as object;
		if (visited.has(objectValue)) {
			continue;
		}
		visited.add(objectValue);
		inspected += 1;

		if (Array.isArray(value)) {
			if (depth < 4) {
				for (const entry of value.slice(0, 40)) {
					queue.push({ value: entry, depth: depth + 1 });
				}
			}
			continue;
		}

		const record = value as RecordValue;
		let payload = buildStructuredPayloadFromRecord(record);
		if (payload) {
			payload = normalizeDownloadCompletePayload(payload);
		}
		if (payload && hasMeaningfulText(payload.title) && hasMeaningfulText(payload.body)) {
			const noiseReason = shouldDropPayloadAsNoise(payload);
			if (noiseReason) {
				continue;
			}
			payload.playSound = true;
			if (shouldUseEventKeyCache(payload) && payload.eventKey && structuredEventKeyTimes.has(payload.eventKey)) {
				continue;
			}

			const fingerprint = payloadFingerprint(payload);
			const lastSeen = structuredFingerprintTimes.get(fingerprint);
			if (typeof lastSeen !== 'number' || now - lastSeen > STRUCTURED_CANDIDATE_TTL_MS) {
				structuredFingerprintTimes.set(fingerprint, now);
				if (shouldUseEventKeyCache(payload) && payload.eventKey) {
					structuredEventKeyTimes.set(payload.eventKey, now);
				}
				recentStructuredNotifications.push({
					payload,
					capturedAt: now,
					fingerprint,
					source,
				});
				console.info(`[steam-native-toasts] Structured capture ${source} ${summarizePayload(payload)}`);
			}
		}

		if (depth >= 4) {
			continue;
		}

		for (const nested of Object.values(record)) {
			if (!nested || typeof nested !== 'object') {
				continue;
			}
			queue.push({ value: nested, depth: depth + 1 });
		}
	}
};

const captureStructuredNotifications = (): void => {
	cleanupCaches();

	const scopedWindow = window as Window & {
		NotificationStore?: unknown;
		SteamNotificationsStore?: unknown;
	};

	captureStructuredNotificationsFromRoot(scopedWindow.NotificationStore, 'NotificationStore');
	captureStructuredNotificationsFromRoot(scopedWindow.SteamNotificationsStore, 'SteamNotificationsStore');
};

const startStructuredCapture = (): void => {
	if (structuredCaptureTimer !== null) {
		return;
	}

	captureStructuredNotifications();
	structuredCaptureTimer = window.setInterval(() => {
		captureStructuredNotifications();
	}, STRUCTURED_CAPTURE_INTERVAL_MS);
};

const rememberFastSuppressedStyle = (element: HTMLElement, property: string): void => {
	const state = fastSuppressedElements.get(element) ?? [];
	if (!state.some((entry) => entry.property === property)) {
		state.push({
			property,
			value: element.style.getPropertyValue(property),
			priority: element.style.getPropertyPriority(property),
		});
		fastSuppressedElements.set(element, state);
	}
};

const makeElementVisuallyBlank = (element: HTMLElement): void => {
	const properties = [
		'opacity',
		'visibility',
		'pointer-events',
		'transition',
		'animation',
		'background',
		'background-image',
		'background-color',
		'box-shadow',
		'border',
		'outline',
		'filter',
		'backdrop-filter',
		'mask-image',
		'text-shadow',
		'color',
	];

	for (const property of properties) {
		rememberFastSuppressedStyle(element, property);
	}

	element.classList.add(FAST_SUPPRESSION_CLASS);
	element.style.setProperty('opacity', '0', 'important');
	element.style.setProperty('visibility', 'hidden', 'important');
	element.style.setProperty('pointer-events', 'none', 'important');
	element.style.setProperty('transition', 'none', 'important');
	element.style.setProperty('animation', 'none', 'important');
	element.style.setProperty('background', 'transparent', 'important');
	element.style.setProperty('background-image', 'none', 'important');
	element.style.setProperty('background-color', 'transparent', 'important');
	element.style.setProperty('box-shadow', 'none', 'important');
	element.style.setProperty('border', '0', 'important');
	element.style.setProperty('outline', '0', 'important');
	element.style.setProperty('filter', 'none', 'important');
	element.style.setProperty('backdrop-filter', 'none', 'important');
	element.style.setProperty('mask-image', 'none', 'important');
	element.style.setProperty('text-shadow', 'none', 'important');
	element.style.setProperty('color', 'transparent', 'important');
};

const transparentlySuppressElement = (element: HTMLElement): void => {
	const targets = new Set<HTMLElement>();
	targets.add(element);

	let ancestor: HTMLElement | null = element.parentElement;
	for (let depth = 0; depth < 2 && ancestor; depth += 1) {
		targets.add(ancestor);
		ancestor = ancestor.parentElement;
	}

	for (const child of Array.from(element.querySelectorAll('*')).slice(0, 60)) {
		if (child instanceof HTMLElement) {
			targets.add(child);
		}
	}

	for (const target of targets) {
		makeElementVisuallyBlank(target);
	}
};

const restoreFastSuppressedElements = (): void => {
	for (const [element, state] of fastSuppressedElements.entries()) {
		if (!element.isConnected) {
			continue;
		}

		element.classList.remove(FAST_SUPPRESSION_CLASS);
		for (let index = state.length - 1; index >= 0; index -= 1) {
			const entry = state[index];
			if (entry.value) {
				element.style.setProperty(entry.property, entry.value, entry.priority);
			} else {
				element.style.removeProperty(entry.property);
			}
		}
	}

	fastSuppressedElements.clear();
};

const looksLikeBottomRightToastHost = (element: HTMLElement): boolean => {
	const rect = element.getBoundingClientRect();
	if (rect.width < 120 || rect.height < 40) {
		return false;
	}

	const nearBottomRight = rect.right >= window.innerWidth - 120 && rect.bottom >= window.innerHeight - 120;
	const popupSized = rect.width <= 700 && rect.height <= 360;
	const style = window.getComputedStyle(element);
	const elevated =
		style.position === 'fixed' ||
		style.position === 'absolute' ||
		style.position === 'sticky' ||
		element.tagName === 'IFRAME';

	const tokens = [
		element.id,
		element.className,
		element.getAttribute('name') ?? '',
		element.getAttribute('title') ?? '',
		element.getAttribute('data-panel') ?? '',
	]
		.join(' ')
		.toLowerCase();

	return (nearBottomRight && popupSized && elevated) || /toast|popup|notification/.test(tokens);
};

const scanFastSuppressionCandidates = (): void => {
	if (Date.now() > startupWarmupDeadline) {
		if (fastSuppressionTimer !== null) {
			window.clearInterval(fastSuppressionTimer);
			fastSuppressionTimer = null;
		}
		restoreFastSuppressedElements();
		return;
	}

	const samplePoints: Array<[number, number]> = [
		[window.innerWidth - 20, window.innerHeight - 20],
		[window.innerWidth - 60, window.innerHeight - 60],
		[window.innerWidth - 140, window.innerHeight - 100],
		[window.innerWidth - 240, window.innerHeight - 140],
	];

	for (const [x, y] of samplePoints) {
		for (const element of document.elementsFromPoint(Math.max(0, x), Math.max(0, y))) {
			if (element instanceof HTMLElement && looksLikeBottomRightToastHost(element)) {
				transparentlySuppressElement(element);
			}
		}
	}

	for (const element of Array.from(document.querySelectorAll('iframe, div, section, aside'))) {
		if (element instanceof HTMLElement && looksLikeBottomRightToastHost(element)) {
			transparentlySuppressElement(element);
		}
	}
};

const beginStartupWarmupSuppression = (): void => {
	if (!shouldGloballySuppressNotificationHosts()) {
		return;
	}

	startupWarmupDeadline = Date.now() + STARTUP_WARMUP_WINDOW_MS;
	scanFastSuppressionCandidates();

	if (fastSuppressionTimer === null) {
		fastSuppressionTimer = window.setInterval(() => {
			scanFastSuppressionCandidates();
		}, 40);
	}
};

const shouldGloballySuppressNotificationHosts = (): boolean => false;

const suppressNotificationHostElement = (element: HTMLElement): void => {
	element.style.setProperty('display', 'none', 'important');
	element.style.setProperty('visibility', 'hidden', 'important');
	element.style.setProperty('opacity', '0', 'important');
	element.style.setProperty('pointer-events', 'none', 'important');
};

const elementLooksLikeNotificationHost = (element: Element): boolean => {
	const tokens = [
		element.id,
		element.getAttribute('name') ?? '',
		element.getAttribute('class') ?? '',
		element.getAttribute('data-panel') ?? '',
	];

	return tokens.some((token) => token.toLowerCase().includes('notificationtoast'));
};

const scanAndSuppressNotificationHosts = (root: ParentNode): void => {
	if (!shouldGloballySuppressNotificationHosts()) {
		return;
	}

	if (root instanceof Element && elementLooksLikeNotificationHost(root)) {
		suppressNotificationHostElement(root as HTMLElement);
	}

	for (const element of Array.from(root.querySelectorAll(NOTIFICATION_HOST_SELECTOR))) {
		if (element instanceof HTMLElement) {
			suppressNotificationHostElement(element);
		}
	}
};

const installGlobalNotificationSuppression = (): void => {
	if (notificationSuppressionStyle || !document.head) {
		return;
	}

	notificationSuppressionStyle = document.createElement('style');
	notificationSuppressionStyle.setAttribute('data-steam-native-toasts', 'notification-suppression');
	notificationSuppressionStyle.textContent = `
${NOTIFICATION_HOST_SELECTOR} {
	display: none !important;
	visibility: hidden !important;
	opacity: 0 !important;
	pointer-events: none !important;
}

.${FAST_SUPPRESSION_CLASS},
.${FAST_SUPPRESSION_CLASS} *,
.${FAST_SUPPRESSION_CLASS}::before,
.${FAST_SUPPRESSION_CLASS}::after,
.${FAST_SUPPRESSION_CLASS} *::before,
.${FAST_SUPPRESSION_CLASS} *::after {
	opacity: 0 !important;
	visibility: hidden !important;
	background: transparent !important;
	background-image: none !important;
	background-color: transparent !important;
	box-shadow: none !important;
	border-color: transparent !important;
	outline: 0 !important;
	filter: none !important;
	backdrop-filter: none !important;
	mask-image: none !important;
	text-shadow: none !important;
	color: transparent !important;
}
`;
	document.head.appendChild(notificationSuppressionStyle);

	notificationSuppressionObserver = new MutationObserver((mutations) => {
		for (const mutation of mutations) {
			for (const node of Array.from(mutation.addedNodes)) {
				if (node instanceof HTMLElement || node instanceof DocumentFragment) {
					scanAndSuppressNotificationHosts(node);
				}
			}
		}
	});

	notificationSuppressionObserver.observe(document.documentElement, {
		childList: true,
		subtree: true,
	});

	scanAndSuppressNotificationHosts(document);
};

const removeGlobalNotificationSuppression = (): void => {
	notificationSuppressionObserver?.disconnect();
	notificationSuppressionObserver = null;

	notificationSuppressionStyle?.remove();
	notificationSuppressionStyle = null;
};

function refreshGlobalNotificationSuppression(): void {
	// Global notification-host CSS can hide a popup before Steam finishes
	// populating its DOM. Keep suppression scoped to the popup being handled.
	removeGlobalNotificationSuppression();
	restoreFastSuppressedElements();
	if (shouldGloballySuppressNotificationHosts()) {
		installGlobalNotificationSuppression();
		return;
	}

	removeGlobalNotificationSuppression();
}

const safePopupName = (popup: unknown): string => {
	if (!popup || typeof popup !== 'object') {
		return '';
	}
	const name = (popup as { m_strName?: unknown }).m_strName;
	return typeof name === 'string' ? name : '';
};

const isNotificationPopup = (name: string): boolean => {
	const lowered = name.toLowerCase();
	return lowered.includes('notificationtoast');
};

const isNoiseLine = (line: string): boolean => {
	if (!line) {
		return true;
	}

	if (/^(steam|https?):\/\//i.test(line)) {
		return true;
	}

	if (/^[<>v^]+$/i.test(line)) {
		return true;
	}

	return false;
};

const normalizeText = (value: string, fallback: string): string => {
	const compact = normalizeWhitespace(value);
	return compact.length > 0 ? compact : fallback;
};

const collectVisiblePopupLines = (doc: Document): string[] => {
	const collected: string[] = [];
	const seen = new Set<string>();
	const root = doc.body ?? doc.documentElement;
	const treeWalker = doc.createTreeWalker(root, NodeFilter.SHOW_TEXT);

	const isVisible = (element: Element | null): boolean => {
		if (!(element instanceof HTMLElement)) {
			return false;
		}

		const style = doc.defaultView?.getComputedStyle(element);
		if (!style || style.display === 'none' || style.visibility === 'hidden') {
			return false;
		}
		return true;
	};

	while (treeWalker.nextNode()) {
		const textNode = treeWalker.currentNode;
		const value = normalizeWhitespace(textNode.textContent ?? '');
		if (!value || value.length > 240 || isNoiseLine(value)) {
			continue;
		}

		if (!isVisible(textNode.parentElement)) {
			continue;
		}

		if (seen.has(value)) {
			continue;
		}
		seen.add(value);
		collected.push(value);
	}

	const nonNumeric = collected.filter((line) => !isLikelyNumericIdentifierText(line));
	return nonNumeric.length > 0 ? nonNumeric : collected;
};

const normalizePopupLines = (lines: string[]): string[] => {
	const seen = new Set<string>();
	const normalized = lines
		.map((line) => normalizeWhitespace(line))
		.filter((line) => line.length > 0 && line.length <= 240)
		.filter((line) => !isNoiseLine(line))
		.filter((line) => {
			if (seen.has(line)) {
				return false;
			}
			seen.add(line);
			return true;
		});

	while (normalized.length >= 2 && normalized[0].toLowerCase() === 'steam') {
		normalized.shift();
	}

	const nonNumeric = normalized.filter((line) => !isLikelyNumericIdentifierText(line));
	return nonNumeric.length > 0 ? nonNumeric : normalized;
};

const POPUP_TEXT_ATTRIBUTE_NAMES = [
	'alt',
	'title',
	'aria-label',
	'data-tooltip-text',
	'data-emoticon',
	'data-name',
	'name',
];
const POPUP_TEXT_ATTRIBUTE_SELECTOR = POPUP_TEXT_ATTRIBUTE_NAMES.map((name) => `[${name}]`).join(',');
const POPUP_ATTRIBUTE_NOISE = new Set(['close', 'dismiss', 'open chat', 'join game', 'view', 'steam', 'notification']);

const collectPopupAttributeLinesFromElement = (element: Element): string[] => {
	const lines: string[] = [];
	for (const attributeName of POPUP_TEXT_ATTRIBUTE_NAMES) {
		const rawValue = element.getAttribute(attributeName);
		const normalizedValue = normalizeSteamMessageText(rawValue) ?? normalizeWhitespace(rawValue ?? '');
		if (!normalizedValue || POPUP_ATTRIBUTE_NOISE.has(normalizedValue.toLowerCase()) || isNoiseLine(normalizedValue)) {
			continue;
		}
		lines.push(normalizedValue);
	}
	return lines;
};

const collectPopupAttributeLinesFromRoot = (root: ParentNode | null | undefined): string[] => {
	if (!root) {
		return [];
	}

	const elements: Element[] = [];
	if (root instanceof Element) {
		elements.push(root);
	}
	elements.push(...Array.from(root.querySelectorAll(POPUP_TEXT_ATTRIBUTE_SELECTOR)).slice(0, 200));

	return normalizePopupLines(elements.flatMap((element) => collectPopupAttributeLinesFromElement(element)));
};

const collectPopupHostLines = (popup: unknown): string[] => {
	const candidates: string[] = [];
	for (const element of resolvePopupHostElements(popup)) {
		candidates.push(element.innerText ?? '');
		candidates.push(element.textContent ?? '');
		candidates.push(...collectPopupAttributeLinesFromElement(element));
		candidates.push(...collectPopupAttributeLinesFromRoot(element));

		const labelledBy = element.getAttribute('aria-label');
		if (labelledBy) {
			candidates.push(labelledBy);
		}
	}

	return normalizePopupLines(
		candidates
			.flatMap((text) => text.split(/\r?\n/))
			.map((line) => line.trim())
	);
};

const buildPopupExtractionFromLines = (
	lines: string[],
	launchUrl: string | undefined,
	icon: string | undefined,
	steamIdHint: string | undefined
): PopupExtraction => {
	const overlayLines = lines.filter((line) => isOverlayTutorialText(line));
	if (overlayLines.length === 1 && lines.length === 1) {
		// Some Steam tutorial popups expose only a single meaningful line.
		// Keep it as the body so we still surface the toast instead of collapsing to generic text.
		return {
			title: 'Steam',
			body: overlayLines[0],
			launchUrl,
			icon,
			steamIdHint,
			usable: true,
		};
	}

	const title = normalizeText(lines[0] ?? '', 'Steam Notification');
	const body = normalizeText(lines.slice(1).join(' ') || lines[0] || '', 'You have a new Steam notification.');
	const usable =
		(hasMeaningfulText(title) && hasMeaningfulText(body)) ||
		isOverlayTutorialText(title) ||
		isOverlayTutorialText(body);
	return { title, body, launchUrl, icon, steamIdHint, usable };
};

const extractPopupText = (popup: unknown): PopupExtraction => {
	try {
		const doc = (popup as { m_popup?: { document?: Document } })?.m_popup?.document;
		if (!doc) {
			const hostLines = collectPopupHostLines(popup);
			return buildPopupExtractionFromLines(hostLines, undefined, undefined, undefined);
		}

		const popupVisibleLines = collectVisiblePopupLines(doc);
		const rawText = doc.body?.innerText?.trim() ?? '';
		const rawTextContent = doc.body?.textContent?.trim() ?? doc.documentElement?.textContent?.trim() ?? '';
		const fallbackLines = (rawText || rawTextContent)
			.split(/\r?\n/)
			.map((line) => line.trim())
			.filter((line) => line.length > 0)
			.filter((line) => !isNoiseLine(line));
		const baseDocLines = normalizePopupLines(popupVisibleLines.length > 0 ? popupVisibleLines : fallbackLines);
		const attributeLines = collectPopupAttributeLinesFromRoot(doc.body ?? doc.documentElement);
		const baseExtraction = buildPopupExtractionFromLines(baseDocLines, undefined, undefined, undefined);
		const docLines =
			baseExtraction.usable || attributeLines.length < 2
				? baseDocLines
				: normalizePopupLines(attributeLines);
		const hostLines = docLines.length > 0 ? [] : collectPopupHostLines(popup);
		const lines = docLines.length > 0 ? docLines : hostLines;
		let icon: string | undefined;
		const images = Array.from(doc.querySelectorAll('img[src]')) as HTMLImageElement[];
		for (const image of images) {
			const src = image.src?.trim();
			if (!src) {
				continue;
			}
			if (/^https?:\/\//i.test(src)) {
				icon = src;
				break;
			}
		}

		const linkCandidates: string[] = [];
		const links = Array.from(doc.querySelectorAll('a[href]')) as HTMLAnchorElement[];
		for (const link of links) {
			const href = link.href?.trim();
			if (!href) {
				continue;
			}
			if (/^(steam|https?):\/\//i.test(href)) {
				linkCandidates.push(href);
			}
		}
		const launchUrl = pickPreferredLaunchUrl(linkCandidates);
		let steamIdHint: string | undefined;
		for (const candidate of linkCandidates) {
			const parsedSteamId = parseSteamIdFromFriendsUrl(candidate);
			if (parsedSteamId) {
				steamIdHint = parsedSteamId;
				break;
			}
		}

		const extraction = buildPopupExtractionFromLines(lines, launchUrl, icon, steamIdHint);
		console.info(
			`[steam-native-toasts] Popup text title="${truncateForLog(extraction.title, 48)}" body="${truncateForLog(extraction.body, 72)}" usable=${extraction.usable ? 'yes' : 'no'}`
		);
		tracePipeline(
			`popup_text usable=${extraction.usable ? 'yes' : 'no'} title=${truncateForLog(extraction.title, 40)} body=${truncateForLog(extraction.body, 60)}`
		);

		return extraction;
	} catch {
		return {
			title: 'Steam Notification',
			body: 'You have a new Steam notification.',
			icon: undefined,
			steamIdHint: undefined,
			usable: false,
		};
	}
};

type PopupSuppressionHandle = {
	restore: () => void;
	finalize: () => void;
};

type BrowserViewPopupLike = {
	GetBounds?: () => { x: number; y: number; width: number; height: number };
	SetBounds?: (x: number, y: number, width: number, height: number) => void;
	SetVisible?: (value: boolean) => void;
	SetFocus?: (value: boolean) => void;
};

const setStyleWithRestore = (
	element: HTMLElement,
	property: string,
	value: string,
	state: Array<{ property: string; value: string; priority: string }>
): void => {
	state.push({
		property,
		value: element.style.getPropertyValue(property),
		priority: element.style.getPropertyPriority(property),
	});
	element.style.setProperty(property, value, 'important');
};

const resolvePopupHostElements = (popup: unknown): HTMLElement[] => {
	const resolved: HTMLElement[] = [];
	const seen = new Set<HTMLElement>();

	const push = (candidate: unknown): void => {
		if (!(candidate instanceof HTMLElement) || seen.has(candidate)) {
			return;
		}

		seen.add(candidate);
		resolved.push(candidate);
	};

	const popupWindow = (popup as { m_popup?: { window?: Window } })?.m_popup?.window;
	const popupDocument = (popup as { m_popup?: { document?: Document } })?.m_popup?.document;
	const frameElement =
		((popupWindow as Window & { frameElement?: Element | null })?.frameElement as HTMLElement | null | undefined) ??
		((popupDocument?.defaultView as Window & { frameElement?: Element | null } | undefined)?.frameElement as HTMLElement | null | undefined);

	push(frameElement);
	push(frameElement?.parentElement ?? undefined);

	if (popupWindow) {
		for (const iframe of Array.from(document.querySelectorAll('iframe'))) {
			if (iframe.contentWindow === popupWindow) {
				push(iframe);
				push(iframe.parentElement ?? undefined);
			}
		}
	}

	return resolved;
};

const createPopupSuppressionHandle = (popup: unknown): PopupSuppressionHandle => {
	const states = new Map<HTMLElement, Array<{ property: string; value: string; priority: string }>>();
	const popupDocument = (popup as { m_popup?: { document?: Document } })?.m_popup?.document;
	const popupBrowserView = (popup as { m_popup?: BrowserViewPopupLike })?.m_popup;
	const hostElements = resolvePopupHostElements(popup);
	const popupElements: HTMLElement[] = [];
	let originalBounds: { x: number; y: number; width: number; height: number } | null = null;

	if (popupDocument?.documentElement instanceof HTMLElement) {
		popupElements.push(popupDocument.documentElement);
	}

	if (popupDocument?.body instanceof HTMLElement) {
		popupElements.push(popupDocument.body);
	}

	for (const element of [...popupElements, ...hostElements]) {
		const state: Array<{ property: string; value: string; priority: string }> = [];
		setStyleWithRestore(element, 'display', 'none', state);
		setStyleWithRestore(element, 'opacity', '0', state);
		setStyleWithRestore(element, 'visibility', 'hidden', state);
		setStyleWithRestore(element, 'pointer-events', 'none', state);
		setStyleWithRestore(element, 'transform', 'translate3d(-200vw, -200vh, 0)', state);
		states.set(element, state);
	}

	try {
		originalBounds = popupBrowserView?.GetBounds?.() ?? null;
		popupBrowserView?.SetFocus?.(false);
		popupBrowserView?.SetVisible?.(false);
		if (originalBounds && popupBrowserView?.SetBounds) {
			popupBrowserView.SetBounds(-32000, -32000, 1, 1);
		}
	} catch {
		// Ignore popup native suppression failures.
	}

	return {
		restore: () => {
			try {
				if (originalBounds && popupBrowserView?.SetBounds) {
					popupBrowserView.SetBounds(originalBounds.x, originalBounds.y, originalBounds.width, originalBounds.height);
				}
				popupBrowserView?.SetVisible?.(true);
			} catch {
				// Ignore popup native restore failures.
			}

			for (const [element, state] of states.entries()) {
				for (let index = state.length - 1; index >= 0; index -= 1) {
					const entry = state[index];
					if (entry.value) {
						element.style.setProperty(entry.property, entry.value, entry.priority);
					} else {
						element.style.removeProperty(entry.property);
					}
				}
			}
		},
		finalize: () => {
			try {
				popupBrowserView?.SetVisible?.(false);
				popupBrowserView?.SetFocus?.(false);
				popupBrowserView?.SetBounds?.(-32000, -32000, 1, 1);
			} catch {
				// Ignore popup native finalize failures.
			}
		},
	};
};

const textOverlap = (left: string, right: string): boolean => {
	const normalizedLeft = normalizeWhitespace(left).toLowerCase();
	const normalizedRight = normalizeWhitespace(right).toLowerCase();
	if (normalizedLeft.length === 0 || normalizedRight.length === 0) {
		return false;
	}

	return normalizedLeft.includes(normalizedRight) || normalizedRight.includes(normalizedLeft);
};

const comparableChatBody = (value: string | undefined): string => {
	let compact = normalizeSteamMessageText(value) ?? normalizeWhitespace(value ?? '');
	if (!compact) {
		return '';
	}

	const prefixedMatch = compact.match(/^.{2,120}?\s*:\s*(.+)$/);
	if (prefixedMatch) {
		compact = prefixedMatch[1];
	}

	return stripQuotedEdges(compact).toLowerCase();
};

const chatBodiesMatch = (left: string | undefined, right: string | undefined): boolean => {
	const normalizedLeft = comparableChatBody(left);
	const normalizedRight = comparableChatBody(right);
	if (!normalizedLeft || !normalizedRight) {
		return false;
	}

	if (normalizedLeft === normalizedRight) {
		return true;
	}

	const shortest = Math.min(normalizedLeft.length, normalizedRight.length);
	return shortest >= 4 && (normalizedLeft.includes(normalizedRight) || normalizedRight.includes(normalizedLeft));
};

const isGenericIncomingVoicePayload = (payload: NativeToastPayload): boolean => {
	if (payload.typeId !== EClientNotificationType.IncomingVoiceChat) {
		return false;
	}

	const normalizedTitle = normalizeWhitespace(payload.title).toLowerCase();
	const normalizedBody = normalizeWhitespace(payload.body).toLowerCase();
	const titleLooksGeneric = isGenericIncomingVoiceText(normalizedTitle);
	const bodyLooksGeneric = isGenericIncomingVoiceText(normalizedBody) || normalizedBody === payload.typeName.toLowerCase();
	return titleLooksGeneric && bodyLooksGeneric;
};

const isUsableStructuredMessage = (payload: NativeToastPayload): boolean => {
	const normalizedTitle = normalizeWhitespace(payload.title);
	const normalizedBody = normalizeWhitespace(payload.body);

	// FriendOnline is intentionally body-only so it reads like a status line
	// instead of a chat headline. That payload is still valid even with no title.
	if (payload.typeId === EClientNotificationType.FriendOnline) {
		return hasMeaningfulText(normalizedBody) && normalizedBody.toLowerCase() !== payload.typeName.toLowerCase();
	}

	return (
		hasMeaningfulText(normalizedTitle) &&
		hasMeaningfulText(normalizedBody) &&
		normalizedBody.toLowerCase() !== payload.typeName.toLowerCase() &&
		(
			payload.typeId !== EClientNotificationType.GroupChatMessage ||
			(
				!isLikelyNumericIdentifierText(normalizedTitle) &&
				!isLikelyNumericIdentifierText(normalizedBody) &&
				!['steam', 'steam: groupchatmessage', 'group chat'].includes(normalizedTitle.toLowerCase()) &&
				!['groupchatmessage', 'new group message', 'new group message.'].includes(normalizedBody.toLowerCase())
			)
		) &&
		(
			payload.typeId !== EClientNotificationType.IncomingVoiceChat ||
			!isGenericIncomingVoicePayload(payload)
		)
	);
};

const normalizeGroupChatBodyText = (body: string): string => {
	const compact = normalizeSteamMessageText(body) ?? normalizeWhitespace(body);
	if (!compact) {
		return body;
	}

	const duplicatedSystemLeadMatch = compact.match(
		/^(.{2,120}?)\s+(has\s+(?:sent|shared|uploaded|added|removed)\b.+|sent\b.+|shared\b.+|uploaded\b.+|added\b.+|removed\b.+)$/i
	);
	if (duplicatedSystemLeadMatch) {
		const collapsedLead = collapseDuplicatedSenderLabel(duplicatedSystemLeadMatch[1]);
		if (collapsedLead) {
			return `${collapsedLead} ${normalizeWhitespace(duplicatedSystemLeadMatch[2])}`;
		}
	}

	const duplicatePrefixMatch = compact.match(/^(.{2,80}?)\s+\1\s*:\s*(.+)$/i);
	if (duplicatePrefixMatch) {
		return `${normalizeWhitespace(duplicatePrefixMatch[1])}: "${normalizeWhitespace(duplicatePrefixMatch[2].replace(/^"|"$/g, ''))}"`;
	}

	const broadPrefixMatch = compact.match(/^(.{2,80}?)\s*:\s*(.+)$/);
	if (broadPrefixMatch) {
		const collapsedSender = collapseDuplicatedSenderLabel(broadPrefixMatch[1]);
		if (collapsedSender && collapsedSender !== normalizeWhitespace(broadPrefixMatch[1])) {
			return `${collapsedSender}: "${normalizeWhitespace(broadPrefixMatch[2].replace(/^"|"$/g, ''))}"`;
		}
	}

	const nestedPrefixMatch = compact.match(/^(.{2,80}?)\s*:\s*"?\1\s*:\s*(.+?)"?$/i);
	if (nestedPrefixMatch) {
		return `${normalizeWhitespace(nestedPrefixMatch[1])}: "${normalizeWhitespace(nestedPrefixMatch[2])}"`;
	}

	return compact;
};

const stripQuotedEdges = (value: string): string => normalizeWhitespace(value.replace(/^["']+|["']+$/g, ''));

const uppercaseFirstCharacter = (value: string): string => {
	if (!value) {
		return value;
	}

	return value.charAt(0).toUpperCase() + value.slice(1);
};

const removeEquivalentSenderPrefix = (message: string, sender: string): string => {
	const compactMessage = normalizeWhitespace(message);
	const compactSender = normalizeWhitespace(sender);
	if (!compactMessage || !compactSender) {
		return compactMessage;
	}

	const senderPrefixMatch = compactMessage.match(/^([^:]{2,80}?)\s*:\s*(.+)$/);
	if (!senderPrefixMatch) {
		return compactMessage;
	}

	if (!senderNamesEquivalent(senderPrefixMatch[1], compactSender)) {
		return compactMessage;
	}

	const stripped = normalizeWhitespace(senderPrefixMatch[2]);
	return stripped.length > 0 ? stripped : compactMessage;
};

const normalizeFriendMessageBodyText = (body: string, sender: string): string => {
	const normalizedBody = normalizeSteamMessageText(body) ?? normalizeWhitespace(body);
	const normalizedSender = normalizeWhitespace(sender);
	if (!normalizedBody || !normalizedSender) {
		return normalizedBody;
	}

	const withoutChatPrefix = removeEquivalentSenderPrefix(normalizedBody, normalizedSender);
	if (withoutChatPrefix !== normalizedBody) {
		return withoutChatPrefix;
	}

	const systemLeadMatch = normalizedBody.match(
		/^(.{2,120}?)\s+(has\s+(?:sent|shared|uploaded|added|removed)\b.+|sent\b.+|shared\b.+|uploaded\b.+|added\b.+|removed\b.+)$/i
	);
	if (!systemLeadMatch) {
		return normalizedBody;
	}

	const collapsedLead = collapseDuplicatedSenderLabel(systemLeadMatch[1]) ?? normalizeWhitespace(systemLeadMatch[1]);
	if (!senderNamesEquivalent(collapsedLead, normalizedSender)) {
		return normalizedBody;
	}

	const remainder = normalizeWhitespace(systemLeadMatch[2]).replace(/^has\s+/i, '');
	return remainder.length > 0 ? uppercaseFirstCharacter(remainder) : normalizedBody;
};

const inferFriendMessageSenderFromBody = (body: string): string | undefined => {
	const normalizedBody = normalizeSteamMessageText(body) ?? normalizeWhitespace(body);
	if (!normalizedBody) {
		return undefined;
	}

	const prefixedMatch = normalizedBody.match(/^([^:]{2,120}?)\s*:\s*(.+)$/);
	if (prefixedMatch) {
		return collapseDuplicatedSenderLabel(prefixedMatch[1]) ?? normalizeWhitespace(prefixedMatch[1]);
	}

	const systemLeadMatch = normalizedBody.match(
		/^(.{2,120}?)\s+(has\s+(?:sent|shared|uploaded|added|removed)\b.+|sent\b.+|shared\b.+|uploaded\b.+|added\b.+|removed\b.+)$/i
	);
	if (systemLeadMatch) {
		return collapseDuplicatedSenderLabel(systemLeadMatch[1]) ?? normalizeWhitespace(systemLeadMatch[1]);
	}

	return undefined;
};

const normalizeVoiceChannelName = (value: string | undefined): string => {
	const compact = normalizeWhitespace(value ?? '');
	if (!compact) {
		return '';
	}

	return compact.replace(/^["']+|["']+$/g, '').trim();
};

const normalizeVoiceInvitePayload = (payload: NativeToastPayload): NativeToastPayload => {
	const currentTitle = normalizeWhitespace(payload.title);
	const currentBody = normalizeWhitespace(payload.body);
	if (!currentBody) {
		return payload;
	}

	const existingActionUrl = payload.actions?.[0]?.url ?? payload.launchUrl;
	const voiceActionUrl = existingActionUrl ?? 'steam://open/friends';
	const voiceActions = [{ label: 'Open Chat', url: voiceActionUrl }];

	if (isVoiceRequestTitle(currentTitle) && isUsefulVoiceTitle(currentBody)) {
		return {
			...payload,
			typeId: EClientNotificationType.IncomingVoiceChat,
			typeName: 'IncomingVoiceChat',
			title: currentBody,
			body: `${currentBody} has opened voice chat and is waiting on you.`,
			launchUrl: voiceActionUrl,
			actions: voiceActions,
		};
	}

	const invitePattern = /^(.{2,80}?)\s+invited you to voice chat in(?:\s+"?(.*)"?)?$/i;
	const inviteBodyOnlyPattern = /^invited you to voice chat in(?:\s+"?(.*)"?)?$/i;
	const fullMatch = currentBody.match(invitePattern);
	const bodyOnlyMatch = currentBody.match(inviteBodyOnlyPattern);

	if (!fullMatch && !bodyOnlyMatch) {
		return payload;
	}

	const inviterFromBody = fullMatch ? asString(fullMatch[1]) : undefined;
	const inviter = asString(currentTitle) ?? inviterFromBody ?? payload.title;
	const voiceNameRaw = (fullMatch ? fullMatch[2] : bodyOnlyMatch?.[1]) ?? '';
	const voiceName = normalizeVoiceChannelName(voiceNameRaw);

	return {
		...payload,
		typeId: EClientNotificationType.IncomingVoiceChat,
		typeName: 'IncomingVoiceChat',
		title: inviter,
		body: `invited you to voice chat in "${voiceName}"`,
		launchUrl: voiceActionUrl,
		actions: voiceActions,
	};
};

const normalizeSocialPopupFallbackPayload = (payload: NativeToastPayload): NativeToastPayload => {
	const currentTitle = normalizeWhitespace(payload.title);
	const currentBody = normalizeWhitespace(payload.body);
	if (!currentTitle || !currentBody) {
		return payload;
	}

	const actionUrl = payload.actions?.[0]?.url ?? payload.launchUrl;
	const resolvedFriendSteamId = payload.friendSteamId ?? resolveFriendSteamIdByDisplayName(currentTitle);
	const fallbackInviteAction =
		actionUrl
			? [{ label: 'Join', url: actionUrl }]
			: [{ label: 'Join', url: 'steam://open/friends' }];
	const fallbackInviteLaunchUrl = fallbackInviteAction[0]?.url;

	const inviteWithSenderMatch = currentBody.match(/^(.{2,120}?)\s+invited you to play(?:\s+(.+))?$/i);
	const inviteBodyOnlyMatch = currentBody.match(/^invited you to play(?:\s+(.+))?$/i);
	if (inviteWithSenderMatch || inviteBodyOnlyMatch) {
		const inviterFromBody = inviteWithSenderMatch
			? collapseDuplicatedSenderLabel(inviteWithSenderMatch[1]) ?? normalizeWhitespace(inviteWithSenderMatch[1])
			: undefined;
		const inviter = inviterFromBody ?? currentTitle;
		const gameNameRaw = inviteWithSenderMatch ? inviteWithSenderMatch[2] : inviteBodyOnlyMatch?.[1] ?? '';
		const gameName = normalizeWhitespace((gameNameRaw ?? '').replace(/^["']+|["']+$/g, '').replace(/\.$/, ''));
		if (inviter && gameName) {
			return {
				...payload,
				typeId: EClientNotificationType.FriendInGame,
				typeName: 'FriendInGame',
				title: inviter,
				body: `${inviter} invited you to play ${gameName}`,
				actions: fallbackInviteAction,
				launchUrl: fallbackInviteLaunchUrl,
				friendSteamId: resolvedFriendSteamId ?? payload.friendSteamId,
			};
		}

		if (inviter) {
			return {
				...payload,
				typeId: EClientNotificationType.FriendInGame,
				typeName: 'FriendInGame',
				title: inviter,
				body: currentBody,
				actions: fallbackInviteAction,
				launchUrl: fallbackInviteLaunchUrl,
				friendSteamId: resolvedFriendSteamId ?? payload.friendSteamId,
			};
		}
	}

	const playingMatch = currentBody.match(/^is playing\s+(.+)$/i);
	if (playingMatch) {
		const gameName = normalizeWhitespace((playingMatch[1] ?? '').replace(/^["']+|["']+$/g, '').replace(/\.$/, ''));
		if (gameName) {
			return {
				...payload,
				typeId: EClientNotificationType.General,
				typeName: 'General',
				title: currentTitle,
				body: `${currentTitle} is playing ${gameName}`,
				actions: [],
				launchUrl: undefined,
				friendSteamId: resolvedFriendSteamId ?? payload.friendSteamId,
			};
		}
	}

	if (payload.typeId === EClientNotificationType.FriendMessage && currentBody.toLowerCase() === 'is now online') {
		return {
			...payload,
			typeId: EClientNotificationType.FriendOnline,
			typeName: 'FriendOnline',
			title: 'Friend',
			body: `${currentTitle} is now online`,
			actions: [],
		};
	}

	return payload;
};

const normalizeFriendMessagePayload = (payload: NativeToastPayload): NativeToastPayload => {
	if (payload.typeId !== EClientNotificationType.FriendMessage) {
		return payload;
	}

	const resolvedSteamId =
		asPositiveIntegerString(payload.friendSteamId) ??
		parseSteamIdFromFriendsUrl(payload.launchUrl);
	const resolvedProfile = resolvedSteamId ? resolveFriendProfileFromStores(resolvedSteamId) : null;
	const normalizedTitle = normalizeWhitespace(payload.title);
	const normalizedBody = normalizeWhitespace(payload.body);
	const inferredSender = inferFriendMessageSenderFromBody(normalizedBody);
	const authoritativeTitle =
		asString(resolvedProfile?.displayName) ??
		inferredSender ??
		collapseDuplicatedSenderLabel(normalizedTitle) ??
		normalizedTitle;

	return {
		...payload,
		title: authoritativeTitle,
		body: normalizeFriendMessageBodyText(normalizedBody, authoritativeTitle),
		friendSteamId: resolvedSteamId ?? payload.friendSteamId,
	};
};

const isGenericFriendOnlineLabel = (value: string | undefined): boolean => {
	const normalized = normalizeWhitespace(value ?? '').toLowerCase();
	return normalized === 'friend' || normalized === 'friends' || normalized === 'steam';
};

const normalizeFriendOnlinePayload = (payload: NativeToastPayload): NativeToastPayload => {
	if (payload.typeId !== EClientNotificationType.FriendOnline) {
		return payload;
	}

	const title = normalizeWhitespace(payload.title);
	if (!title) {
		return payload;
	}

	const resolvedSteamId =
		asPositiveIntegerString(payload.friendSteamId) ??
		parseSteamIdFromFriendsUrl(payload.launchUrl);
	const resolvedProfile = resolvedSteamId ? resolveFriendProfileFromStores(resolvedSteamId) : null;
	const resolvedName =
		!isGenericFriendOnlineLabel(title) ? title :
		asString(resolvedProfile?.displayName) ??
		title;

	return {
		...payload,
		typeId: EClientNotificationType.FriendOnline,
		typeName: 'FriendOnline',
		title: 'Friend',
		body: `${collapseDuplicatedSenderLabel(resolvedName) ?? resolvedName} is now online`,
		actions: [],
	};
};

const normalizeDuplicateLabelArtifacts = (payload: NativeToastPayload): NativeToastPayload => {
	let nextTitle = normalizeWhitespace(payload.title);
	let nextBody = normalizeWhitespace(payload.body);

	if (payload.typeId === EClientNotificationType.FriendMessage) {
		nextBody = normalizeFriendMessageBodyText(nextBody, nextTitle);
	}

	if (payload.typeId === EClientNotificationType.GroupChatMessage) {
		nextBody = normalizeGroupChatBodyText(nextBody);
	}

	if (payload.typeId === EClientNotificationType.General) {
		nextBody = normalizeGroupChatBodyText(nextBody);
	}

	// Caller/status flows can still arrive with duplicated persona labels.
	// Keep this cleanup scoped so normal message titles are left untouched.
	if (payload.typeId === EClientNotificationType.IncomingVoiceChat) {
		const collapsedTitle = collapseDuplicatedSenderLabel(nextTitle);
		if (collapsedTitle) {
			nextTitle = collapsedTitle;
		}

		const voiceBodyMatch = nextBody.match(/^(.{2,80}?)\s+has opened voice chat and is waiting on you\.$/i);
		if (voiceBodyMatch) {
			const collapsedBodyName = collapseDuplicatedSenderLabel(voiceBodyMatch[1]) ?? voiceBodyMatch[1];
			const bestName = senderNamesEquivalent(collapsedBodyName, nextTitle) ? nextTitle : collapsedBodyName;
			nextBody = `${bestName} has opened voice chat and is waiting on you.`;
		}
	}

	if (payload.typeId === EClientNotificationType.FriendOnline) {
		const onlineBodyMatch = nextBody.match(/^(.{2,80}?)\s+is now online$/i);
		if (onlineBodyMatch) {
			const collapsedBodyName = collapseDuplicatedSenderLabel(onlineBodyMatch[1]) ?? onlineBodyMatch[1];
			nextBody = `${collapsedBodyName} is now online`;
		}
	}

	return {
		...payload,
		title: nextTitle,
		body: nextBody,
	};
};

const parseAppIdFromRunUrl = (value: string | undefined): string | undefined => {
	const url = asString(value);
	if (!url) {
		return undefined;
	}

	const match = url.match(/^steam:\/\/run\/(\d+)$/i);
	return match ? match[1] : undefined;
};

const extractDownloadCompleteAppNameFromText = (value: string | undefined): string | undefined => {
	const compact = normalizeWhitespace(value ?? '');
	if (!compact) {
		return undefined;
	}

	const prefixedReadyMatch = compact.match(/^(.{2,120}?)\s+your game is ready to play\.?$/i);
	if (prefixedReadyMatch) {
		return stripQuotedEdges(prefixedReadyMatch[1]);
	}

	const quotedReadyMatch = compact.match(/^your game\s+["'](.{2,120}?)["']\s+is ready to play\.?$/i);
	if (quotedReadyMatch) {
		return stripQuotedEdges(quotedReadyMatch[1]);
	}

	return undefined;
};

const normalizeDownloadCompletePayload = (payload: NativeToastPayload): NativeToastPayload => {
	if (payload.typeId !== EClientNotificationType.DownloadComplete) {
		return payload;
	}

	const appId = parseAppIdFromRunUrl(payload.launchUrl);
	const appProfile = appId ? resolveAppProfileFromStores(appId) : null;
	const body = normalizeWhitespace(payload.body);
	const bodyLower = body.toLowerCase();
	const genericBody =
		!body ||
		bodyLower === 'downloadcomplete' ||
		bodyLower === payload.typeName.toLowerCase() ||
		bodyLower === 'steam: downloadcomplete';
	const appName = asString(appProfile?.name) ?? extractDownloadCompleteAppNameFromText(body);
	return {
		...payload,
		title: 'Download Complete',
		body: genericBody
			? (appName ? `Your game "${appName}" is ready to play` : 'Your game is ready to play')
			: (appName ? `Your game "${appName}" is ready to play` : body),
		actions: [],
	};
};

const shouldDropPayloadAsNoise = (payload: NativeToastPayload): string | null => {
	const title = normalizeWhitespace(payload.title);
	const body = normalizeWhitespace(payload.body);
	const bodyLower = body.toLowerCase();

	if (payload.typeId === EClientNotificationType.General) {
		if (!hasMeaningfulText(title) || !hasMeaningfulText(body)) {
			return 'general_generic';
		}
	}

	if (payload.typeId === EClientNotificationType.FriendMessage) {
		if (GENERIC_FRIEND_MESSAGE_BODIES.has(bodyLower)) {
			return 'friend_message_generic';
		}
		if (bodyLower === 'is now online' || bodyLower.startsWith('is playing ')) {
			return 'friend_message_misclassified_social';
		}
	}

	if (payload.typeId === EClientNotificationType.FriendOnline) {
		if (/^(friend|friends|steam)\s+is now online$/i.test(body)) {
			return 'friend_online_missing_persona';
		}
	}

	return null;
};

const inferPopupFallbackTypeId = (extracted: PopupExtraction, structuredTemplate?: NativeToastPayload): number => {
	if (structuredTemplate) {
		return structuredTemplate.typeId;
	}

	if (looksLikeVoiceRequestPopup(extracted) || /\binvited you to voice chat in\b/i.test(extracted.body)) {
		return EClientNotificationType.IncomingVoiceChat;
	}

	if (/^steam:\/\/friends\/(?:message|openchat|startchat)\/\d{5,}/i.test(extracted.launchUrl ?? '')) {
		return EClientNotificationType.FriendMessage;
	}

	const senderFromBody = inferFriendMessageSenderFromBody(extracted.body);
	if (senderFromBody && !senderNamesEquivalent(senderFromBody, extracted.title)) {
		return EClientNotificationType.GroupChatMessage;
	}

	if (isSingleSteamEmojiMessage(extracted.body) && isUsefulVoiceTitle(extracted.title)) {
		return EClientNotificationType.FriendMessage;
	}

	return EClientNotificationType.General;
};

const buildPopupFallbackPayload = (extracted: PopupExtraction, structuredTemplate?: NativeToastPayload): NativeToastPayload => {
	const fallbackTypeId = inferPopupFallbackTypeId(extracted, structuredTemplate);
	const fallbackTypeName = structuredTemplate?.typeName ?? resolveTypeName(fallbackTypeId);
	const launchUrl = extracted.launchUrl ?? structuredTemplate?.launchUrl;
	const fallbackAction = launchUrl ? [{ label: defaultActionLabel(fallbackTypeId), url: launchUrl }] : [];
	return {
		typeId: fallbackTypeId,
		typeName: fallbackTypeName,
		title: extracted.title,
		body: extracted.body,
		playSound: true,
		icon: extracted.icon ?? structuredTemplate?.icon,
		launchUrl,
		actions: structuredTemplate?.actions && structuredTemplate.actions.length > 0 ? structuredTemplate.actions : fallbackAction,
		friendSteamId: structuredTemplate?.friendSteamId ?? extracted.steamIdHint,
	};
};

const enrichIncomingVoicePayload = (
	payload: NativeToastPayload,
	extracted?: PopupExtraction
): NativeToastPayload => {
	if (payload.typeId !== EClientNotificationType.IncomingVoiceChat) {
		return payload;
	}

	const actionLaunchUrl = payload.actions?.[0]?.url;
	const fallbackVoiceLaunchUrl = extracted?.launchUrl ?? payload.launchUrl ?? actionLaunchUrl ?? 'steam://open/friends';
	const fallbackVoiceActions = [{ label: 'Open Chat', url: fallbackVoiceLaunchUrl }];
	if (/\binvited you to voice chat in\b/i.test(payload.body)) {
		return {
			...payload,
			launchUrl: fallbackVoiceLaunchUrl,
			actions: payload.actions && payload.actions.length > 0 ? payload.actions : fallbackVoiceActions,
		};
	}

	const steamId =
		asPositiveIntegerString(payload.friendSteamId) ??
		asPositiveIntegerString(extracted?.steamIdHint) ??
		parseSteamIdFromFriendsUrl(extracted?.launchUrl) ??
		parseSteamIdFromFriendsUrl(payload.launchUrl) ??
		parseSteamIdFromFriendsUrl(actionLaunchUrl);
	const profile = steamId ? resolveFriendProfileFromStores(steamId) : null;
	const extractedCallerFromBody = (() => {
		const body = asString(extracted?.body);
		if (!body) {
			return undefined;
		}

		if (isVoiceRequestTitle(extracted?.title) && isUsefulVoiceTitle(body)) {
			return body;
		}

		const match = normalizeWhitespace(body).match(/^(.{2,80}?)\s+is\s+calling\s+you\b/i);
		if (!match) {
			return undefined;
		}

		const caller = asString(match[1]);
		return isUsefulVoiceTitle(caller) ? caller : undefined;
	})();

	const extractedTitle = isUsefulVoiceTitle(extracted?.title) ? asString(extracted?.title) : undefined;
	const payloadTitle = isUsefulVoiceTitle(payload.title) ? payload.title : undefined;
	const finalTitle = profile?.displayName ?? extractedCallerFromBody ?? extractedTitle ?? payloadTitle ?? 'Steam';

	const bodyName = finalTitle !== 'Steam' ? finalTitle : 'A friend';
	const finalBody = `${bodyName} has opened voice chat and is waiting on you.`;

	const icon = preferredAvatarUrl(profile?.avatarUrl, payload.icon, extracted?.icon);
	const launchUrl = fallbackVoiceLaunchUrl;
	const actions =
		payload.actions && payload.actions.length > 0
			? payload.actions
			: fallbackVoiceActions;

	const enriched: NativeToastPayload = {
		...payload,
		title: finalTitle,
		body: finalBody,
		launchUrl,
		actions,
	};
	if (icon) {
		enriched.icon = icon;
	}

	return enriched;
};

const resolveIncomingVoicePayloadWithRetries = async (
	initialPayload: NativeToastPayload,
	extracted?: PopupExtraction
): Promise<NativeToastPayload> => {
	if (initialPayload.typeId !== EClientNotificationType.IncomingVoiceChat) {
		return initialPayload;
	}

	let payload = enrichIncomingVoicePayload(initialPayload, extracted);
	if (isUsableStructuredMessage(payload)) {
		return payload;
	}

	for (let attempt = 0; attempt < 4; attempt += 1) {
		await sleep(120);
		payload = enrichIncomingVoicePayload(payload, extracted);
		if (isUsableStructuredMessage(payload)) {
			return payload;
		}
	}

	return payload;
};

const buildIncomingVoiceEmergencyFallback = (payload: NativeToastPayload): NativeToastPayload => {
	if (payload.typeId !== EClientNotificationType.IncomingVoiceChat) {
		return payload;
	}

	const actionUrl = payload.actions?.[0]?.url ?? payload.launchUrl;
	const title = isUsefulVoiceTitle(payload.title) ? payload.title : 'Steam';
	return {
		...payload,
		title,
		body:
			title !== 'Steam'
				? `${title} has opened voice chat and is waiting on you.`
				: 'A friend has opened voice chat and is waiting on you.',
		actions: actionUrl ? [{ label: 'Open Chat', url: actionUrl }] : payload.actions,
	};
};

const groupContextKey = (sender: string | undefined): string | undefined => {
	const compact = collapseDuplicatedSenderLabel(sender) ?? normalizeWhitespace(sender ?? '');
	return compact ? compact.toLowerCase() : undefined;
};

const rememberGroupChatContext = (payload: NativeToastPayload, now: number): void => {
	if (payload.typeId !== EClientNotificationType.GroupChatMessage || !isUsableStructuredMessage(payload)) {
		return;
	}

	const sender = inferFriendMessageSenderFromBody(payload.body);
	const key = groupContextKey(sender);
	const groupTitle = normalizeWhitespace(payload.title);
	if (!key || !groupTitle || isGenericText(groupTitle) || isLikelyNumericIdentifierText(groupTitle)) {
		return;
	}

	recentGroupChatContextBySender.set(key, {
		groupTitle,
		sender: collapseDuplicatedSenderLabel(sender) ?? normalizeWhitespace(sender ?? ''),
		icon: payload.icon,
		launchUrl: payload.launchUrl,
		capturedAt: now,
	});

	for (const [contextKey, context] of recentGroupChatContextBySender) {
		if (now - context.capturedAt > 5 * 60_000) {
			recentGroupChatContextBySender.delete(contextKey);
		}
	}
};

const isSingleSteamEmojiMessage = (value: string | undefined): boolean => {
	const normalized = stripQuotedEdges(normalizeSteamMessageText(value) ?? normalizeWhitespace(value ?? ''));
	return /^:[a-z0-9_.-]+:$/i.test(normalized);
};

const findRecentGroupEmojiStructuredFallback = (extracted: PopupExtraction, now: number): NativeToastPayload | null => {
	if (extracted.usable || /^steam:\/\/friends\/message\//i.test(extracted.launchUrl ?? '')) {
		return null;
	}

	const candidates = [...recentStructuredNotifications]
		.filter((candidate) => now - candidate.capturedAt <= 2_500)
		.sort((left, right) => right.capturedAt - left.capturedAt);

	for (const candidate of candidates) {
		const payload = candidate.payload;
		if (payload.typeId !== EClientNotificationType.FriendMessage && payload.typeId !== EClientNotificationType.GroupChatMessage) {
			continue;
		}
		if (!isSingleSteamEmojiMessage(payload.body)) {
			continue;
		}

		const sender = collapseDuplicatedSenderLabel(payload.title) ?? normalizeWhitespace(payload.title);
		const key = groupContextKey(sender);
		const context = key ? recentGroupChatContextBySender.get(key) : undefined;
		if (!context || now - context.capturedAt > 60_000) {
			continue;
		}

		const emojiText = stripQuotedEdges(normalizeSteamMessageText(payload.body) ?? normalizeWhitespace(payload.body));
		return {
			...payload,
			typeId: EClientNotificationType.GroupChatMessage,
			typeName: 'GroupChatMessage',
			title: context.groupTitle,
			body: `${context.sender}: "${emojiText}"`,
			icon: payload.icon ?? context.icon,
			launchUrl: extracted.launchUrl ?? payload.launchUrl ?? context.launchUrl,
			playSound: true,
		};
	}

	return null;
};

const findMatchingStructuredNotification = (extracted: PopupExtraction, now: number): StructuredNotificationCandidate | null => {
	let bestMatch: StructuredNotificationCandidate | null = null;
	let bestScore = Number.NEGATIVE_INFINITY;

	for (const candidate of recentStructuredNotifications) {
		const age = now - candidate.capturedAt;
		if (age > STRUCTURED_CANDIDATE_TTL_MS) {
			continue;
		}

		if (!extracted.usable && (!extracted.launchUrl || candidate.payload.launchUrl !== extracted.launchUrl)) {
			continue;
		}

		const isChatMessageCandidate =
			candidate.payload.typeId === EClientNotificationType.FriendMessage ||
			candidate.payload.typeId === EClientNotificationType.GroupChatMessage;
		const bodyMatches = extracted.usable && chatBodiesMatch(candidate.payload.body, extracted.body);
		if (extracted.usable && isChatMessageCandidate && !bodyMatches) {
			// Chat popups often share the same sender/title for many messages.
			// Never let a stale structured body override fresh popup text.
			continue;
		}

		let score = 0;
		score += Math.max(0, 6 - Math.floor(age / 2000));

		if (MESSAGE_NOTIFICATION_TYPES.has(candidate.payload.typeId)) {
			score += 3;
		}

		if (extracted.usable && textOverlap(candidate.payload.title, extracted.title)) {
			score += 4;
		}

		if (bodyMatches || (extracted.usable && !isChatMessageCandidate && textOverlap(candidate.payload.body, extracted.body))) {
			score += 4;
		}

		if (extracted.launchUrl && candidate.payload.launchUrl === extracted.launchUrl) {
			score += extracted.usable ? 2 : 6;
		}

		if (score > bestScore) {
			bestScore = score;
			bestMatch = candidate;
		}
	}

	if (bestMatch && bestScore >= 4) {
		return bestMatch;
	}

	return null;
};

const applyPopupDomSuppression = (popup: unknown): void => {
	try {
		for (const element of resolvePopupHostElements(popup)) {
			element.style.setProperty('display', 'none', 'important');
			element.style.setProperty('visibility', 'hidden', 'important');
			element.style.setProperty('opacity', '0', 'important');
			element.style.setProperty('pointer-events', 'none', 'important');
			element.style.setProperty('transform', 'translate3d(-200vw, -200vh, 0)', 'important');
		}

		const doc = (popup as { m_popup?: { document?: Document } })?.m_popup?.document;
		if (doc?.documentElement) {
			doc.documentElement.style.setProperty('display', 'none', 'important');
			doc.documentElement.style.setProperty('visibility', 'hidden', 'important');
			doc.documentElement.style.setProperty('opacity', '0', 'important');
			doc.documentElement.style.setProperty('pointer-events', 'none', 'important');
		}

		if (doc?.body) {
			doc.body.style.setProperty('display', 'none', 'important');
			doc.body.style.setProperty('visibility', 'hidden', 'important');
			doc.body.style.setProperty('opacity', '0', 'important');
			doc.body.style.setProperty('pointer-events', 'none', 'important');
		}
	} catch {
		// Ignore style failures.
	}
};

const tryHideSteamPopup = async (popup: unknown): Promise<void> => {
	applyPopupDomSuppression(popup);
	const popupBrowserView = (popup as { m_popup?: BrowserViewPopupLike })?.m_popup;

	try {
		popupBrowserView?.SetFocus?.(false);
		popupBrowserView?.SetVisible?.(false);
		popupBrowserView?.SetBounds?.(-32000, -32000, 1, 1);
	} catch {
		// Ignore popup native suppression failures.
	}

	for (let attempt = 0; attempt < 30; attempt += 1) {
		await sleep(100);
		applyPopupDomSuppression(popup);

		try {
			popupBrowserView?.SetFocus?.(false);
			popupBrowserView?.SetVisible?.(false);
			popupBrowserView?.SetBounds?.(-32000, -32000, 1, 1);
		} catch {
			// Ignore popup native suppression failures.
		}
	}
};

const permanentlySuppressPopupNow = (popup: unknown, suppressionHandle: PopupSuppressionHandle | null): void => {
	suppressionHandle?.finalize();
	void tryHideSteamPopup(popup);
};

const isImportantToast = (payload: NativeToastPayload): boolean => {
	if (
		payload.typeId === EClientNotificationType.IncomingVoiceChat ||
		payload.typeId === EClientNotificationType.FriendInvite ||
		payload.typeId === EClientNotificationType.FriendInGame ||
		payload.typeId === EClientNotificationType.TradeOffer ||
		payload.typeId === EClientNotificationType.FamilyInvite ||
		payload.typeId === EClientNotificationType.FamilyPurchaseRequest
	) {
		return true;
	}

	return isOverlayTutorialText(payload.title) || isOverlayTutorialText(payload.body);
};

const shouldBypassDoNotDisturbForPayload = (payload: NativeToastPayload): boolean => {
	if (runtimeConfig.priorityMode === PRIORITY_MODE.NONE) {
		return false;
	}

	if (runtimeConfig.priorityMode === PRIORITY_MODE.ALL) {
		return true;
	}

	return isImportantToast(payload);
};

const sendPayloadToBackend = async (payload: NativeToastPayload): Promise<boolean> => {
	try {
		const tracedPayload = ensureDebugPayload(payload, payload.debugSource ?? 'direct_send');
		const primaryAction = payload.actions?.[0];
		const shouldBypassDoNotDisturb = shouldBypassDoNotDisturbForPayload(tracedPayload);
		const payloadBlob = [
			tracedPayload.typeName,
			tracedPayload.title,
			tracedPayload.body,
			tracedPayload.icon ?? '',
			tracedPayload.launchUrl ?? primaryAction?.url ?? '',
			tracedPayload.playSound ? '1' : '0',
			primaryAction?.label ?? '',
			primaryAction?.url ?? '',
			tracedPayload.debugTraceId ?? '',
			tracedPayload.debugSource ?? '',
			shouldBypassDoNotDisturb ? '1' : '0',
		].join('\x1f');
		console.info(
			`[steam-native-toasts] Forward start trace=${tracedPayload.debugTraceId} source=${tracedPayload.debugSource} ${summarizePayload(tracedPayload)}`
		);
		tracePipeline(
			`forward_start trace=${tracedPayload.debugTraceId} source=${tracedPayload.debugSource} type=${tracedPayload.typeName} title=${truncateForLog(tracedPayload.title, 40)} body=${truncateForLog(tracedPayload.body, 60)}`
		);
		const result = await sendNativeToast({ payload_blob: payloadBlob });
		const succeeded = didBackendToastSendSucceed(result);
		console.info(
			`[steam-native-toasts] Forward done trace=${tracedPayload.debugTraceId} success=${succeeded ? 'yes' : 'no'} result=${summarizeBackendResult(result)} ${summarizePayload(tracedPayload)}`
		);
		tracePipeline(
			`forward_done trace=${tracedPayload.debugTraceId} source=${tracedPayload.debugSource} success=${succeeded ? 'yes' : 'no'} result=${summarizeBackendResult(result)}`
		);
		return succeeded;
	} catch (error) {
		tracePipeline(
			`forward_error trace=${payload.debugTraceId ?? 'none'} source=${payload.debugSource ?? 'unknown'}`
		);
		console.error(
			`[steam-native-toasts] Failed to send payload to backend trace=${payload.debugTraceId ?? 'none'} source=${payload.debugSource ?? 'unknown'}`,
			error
		);
		return false;
	}
};

const summarizeBackendResult = (result: unknown): string => {
	if (result === null) {
		return 'null';
	}
	if (typeof result === 'undefined') {
		return 'undefined';
	}
	if (typeof result === 'boolean' || typeof result === 'number' || typeof result === 'string') {
		return truncateForLog(String(result), 40);
	}
	if (typeof result === 'object') {
		const record = result as Record<string, unknown>;
		const keys = Object.keys(record).slice(0, 6).join(',');
		return `object:${keys || 'empty'}`;
	}
	return typeof result;
};

const didBackendToastSendSucceed = (result: unknown): boolean => {
	if (result === false || result === 0) {
		return false;
	}
	if (typeof result === 'string') {
		return !['false', 'failure', 'failed', 'error', '0'].includes(result.trim().toLowerCase());
	}
	if (typeof result === 'object' && result !== null) {
		const record = result as Record<string, unknown>;
		for (const key of ['success', 'ok', 'result', 'status']) {
			if (key in record) {
				return didBackendToastSendSucceed(record[key]);
			}
		}
	}

	// Millennium builds have differed on what a Lua return value becomes in JS.
	// If the call did not throw and did not explicitly return failure, count it.
	return true;
};

const forwardPayload = async (payload: NativeToastPayload): Promise<boolean> => {
	const tracedPayload = ensureDebugPayload(payload, payload.debugSource ?? 'forward');
	const enqueuedAt = Date.now();

	return new Promise<boolean>((resolve) => {
		const run = async (): Promise<void> => {
			const now = Date.now();
			const waitMs = Math.max(0, nextToastForwardEarliestMs - now);
			const queueAgeMs = now - enqueuedAt;
			tracePipeline(
				`queue trace=${tracedPayload.debugTraceId} source=${tracedPayload.debugSource} wait_ms=${waitMs} age_ms=${queueAgeMs} title=${truncateForLog(tracedPayload.title, 40)} body=${truncateForLog(tracedPayload.body, 60)}`
			);
			console.info(
				`[steam-native-toasts] Queue toast trace=${tracedPayload.debugTraceId} wait_ms=${waitMs} age_ms=${queueAgeMs} ${summarizePayload(tracedPayload)}`
			);
			if (waitMs > 0) {
				await sleep(waitMs);
			}

			const sendStartedAt = Date.now();
			const forwarded = await sendPayloadToBackend(tracedPayload);
			const sendMs = Date.now() - sendStartedAt;
			tracePipeline(
				`queue_done trace=${tracedPayload.debugTraceId} source=${tracedPayload.debugSource} success=${forwarded ? 'yes' : 'no'} age_ms=${Date.now() - enqueuedAt} send_ms=${sendMs}`
			);
			nextToastForwardEarliestMs = Date.now() + TOAST_FORWARD_MIN_GAP_MS;
			resolve(forwarded);
		};

		toastForwardQueue = toastForwardQueue
			.catch(() => {
				// Keep the single-lane sender alive if a previous send failed.
			})
			.then(run);
	});
};

// Steam can re-fire the same popup callback while it is animating in and out.
// Keeping a short signature window here prevents duplicate Windows toasts.
const shouldSkipDuplicateForward = (payload: NativeToastPayload, now: number): boolean => {
	const signature = payloadFingerprint(payload);
	const previous = recentlyForwarded.get(signature);
	if (typeof previous === 'number' && now - previous < DUPLICATE_FORWARD_WINDOW_MS) {
		tracePipeline(
			`dup_skip trace=${payload.debugTraceId ?? 'none'} source=${payload.debugSource ?? 'unknown'} delta_ms=${now - previous} signature=${truncateForLog(signature, 80)}`
		);
		console.info(
			`[steam-native-toasts] Duplicate skip trace=${payload.debugTraceId ?? 'none'} source=${payload.debugSource ?? 'unknown'} delta_ms=${now - previous} signature="${truncateForLog(signature, 96)}"`
		);
		return true;
	}

	recentlyForwarded.set(signature, now);
	return false;
};

// This is the only code path that may send a visible Windows toast.
// Structured stores, popup scraping, retries, dedupe, and suppression all meet
// here so we do not reintroduce the old loop/drop race from competing senders.
const handlePopupCreated = async (popup: unknown): Promise<void> => {
	let suppressionHandle: PopupSuppressionHandle | null = null;
	let keepSuppressed = false;
	const suppressNow = (): void => {
		if (!runtimeConfig.hideSteamToast || keepSuppressed) {
			return;
		}

		if (!suppressionHandle) {
			suppressionHandle = createPopupSuppressionHandle(popup);
		}
		keepSuppressed = true;
		permanentlySuppressPopupNow(popup, suppressionHandle);
	};

	try {
		if (!runtimeConfig.enabled) {
			return;
		}

		const name = safePopupName(popup);
		if (!isNotificationPopup(name)) {
			return;
		}

		// This is the only place that is allowed to send a user-visible toast.
		// Everything else just feeds metadata into the match/fallback logic here.
		captureStructuredNotifications();
		const now = Date.now();
		await sleep(40);
		let extracted = extractPopupText(popup);
		let matched = findMatchingStructuredNotification(extracted, now);
		const matchedIsGenericMessage = (): boolean =>
			!!matched &&
			MESSAGE_NOTIFICATION_TYPES.has(matched.payload.typeId) &&
			!isUsableStructuredMessage(matched.payload);
		if (!extracted.usable && (!matched || matchedIsGenericMessage())) {
			for (const retryDelay of POPUP_EXTRACTION_RETRY_DELAYS_MS) {
				await sleep(retryDelay);
				captureStructuredNotifications();
				const retryExtracted = extractPopupText(popup);
				const retryMatched = findMatchingStructuredNotification(retryExtracted, now);
				if (retryExtracted.usable) {
					extracted = retryExtracted;
				}
				if (retryMatched) {
					matched = retryMatched;
				}
				if (extracted.usable || matched) {
					break;
				}
			}
		}
		if (matched?.payload.typeId === EClientNotificationType.FriendOnline && looksLikeVoiceRequestPopup(extracted)) {
			console.info('[steam-native-toasts] Ignored FriendOnline structured match because popup text is a voice request');
			matched = null;
		}

		let payload: NativeToastPayload | null = null;
		let matchedStructuredMessage = false;

		if (matched) {
			matchedStructuredMessage = MESSAGE_NOTIFICATION_TYPES.has(matched.payload.typeId);
			console.info(
				`[steam-native-toasts] Matched structured source=${matched.source} age_ms=${now - matched.capturedAt} ${summarizePayload(matched.payload)}`
			);

			if (matched.payload.typeId === EClientNotificationType.FriendMessage) {
				if (isUsableStructuredMessage(matched.payload)) {
					payload = {
						...matched.payload,
						playSound: true,
					};
					payload = ensureDebugPayload(payload, `matched:${matched.source}`);
					console.info('[steam-native-toasts] Friend message using structured payload as primary content source');
				} else {
					console.info('[steam-native-toasts] Friend message structured payload unusable; trying popup fallback');
				}
			} else if (
				matched.payload.typeId === EClientNotificationType.FriendOnline &&
				extracted.usable &&
				!isGenericFriendOnlineLabel(extracted.title) &&
				isGenericFriendOnlineLabel(matched.payload.title)
			) {
				payload = buildPopupFallbackPayload(extracted, matched.payload);
				payload = ensureDebugPayload(payload, 'popup_fallback_online');
				console.info('[steam-native-toasts] Friend online used popup title because structured title was generic');
			} else if (matched.payload.typeId === EClientNotificationType.GroupChatMessage) {
				if (isUsableStructuredMessage(matched.payload)) {
					payload = {
						...matched.payload,
						playSound: true,
					};
					console.info('[steam-native-toasts] Group chat using structured payload as primary content source');
				} else {
					console.info('[steam-native-toasts] Group chat structured payload unusable; trying popup fallback');
				}
			} else
			if (
				matchedStructuredMessage &&
				matched.payload.typeId !== EClientNotificationType.FriendMessage &&
				matched.payload.typeId !== EClientNotificationType.IncomingVoiceChat &&
				!isUsableStructuredMessage(matched.payload)
			) {
				console.info('[steam-native-toasts] Rejected structured chat candidate because content was generic or incomplete; trying popup fallback');
			} else {
				payload = {
					...matched.payload,
					playSound: true,
				};
				payload = ensureDebugPayload(payload, `matched:${matched.source}`);
			}
		}

		if (!payload && extracted.usable) {
			payload = buildPopupFallbackPayload(extracted, matched?.payload);
			payload = ensureDebugPayload(payload, 'popup_fallback');
			console.info(`[steam-native-toasts] Using popup fallback ${summarizePayload(payload)}`);
		} else if (!payload && matched?.payload.typeId === EClientNotificationType.FriendMessage) {
			const friendFallbackCandidate: NativeToastPayload = {
				...matched.payload,
				playSound: true,
			};
			if (isUsableStructuredMessage(friendFallbackCandidate) && normalizeWhitespace(friendFallbackCandidate.body).toLowerCase() !== 'friendmessage') {
				payload = ensureDebugPayload(friendFallbackCandidate, 'friend_structured_fallback');
				console.info(`[steam-native-toasts] Friend popup text missing; using structured fallback ${summarizePayload(payload)}`);
			} else {
				console.info('[steam-native-toasts] Friend structured fallback stayed generic; leaving Steam popup visible');
			}
		} else if (
			payload &&
			payload.typeId === EClientNotificationType.IncomingVoiceChat &&
			(!isUsableStructuredMessage(payload) || normalizeWhitespace(payload.title).toLowerCase() === 'steam') &&
			extracted.usable
		) {
			payload = buildPopupFallbackPayload(extracted, payload);
			payload = ensureDebugPayload(payload, 'popup_fallback_voice');
			console.info(`[steam-native-toasts] Using popup fallback ${summarizePayload(payload)}`);
		}
		if (!payload && matched?.payload.typeId === EClientNotificationType.GroupChatMessage) {
			const structuredFallback: NativeToastPayload = ensureDebugPayload({
				...matched.payload,
				playSound: true,
			}, `group_fallback:${matched.source}`);
			if (isUsableStructuredMessage(structuredFallback)) {
				payload = structuredFallback;
				console.info(`[steam-native-toasts] Group chat popup text missing; using structured fallback ${summarizePayload(payload)}`);
			} else {
				console.info('[steam-native-toasts] Group chat fallback stayed generic; leaving Steam popup visible');
			}
		}
		if (!payload && !extracted.usable) {
			const groupEmojiFallback = findRecentGroupEmojiStructuredFallback(extracted, now);
			if (groupEmojiFallback) {
				payload = ensureDebugPayload(groupEmojiFallback, 'group_emoji_context_fallback');
				console.info(`[steam-native-toasts] Group emoji recovered from recent group context ${summarizePayload(payload)}`);
			}
		}

		if (!payload) {
			// Some Steam popup variants populate text a little later.
			// Take one last pass before we declare this popup unusable.
			await sleep(180);
			captureStructuredNotifications();
			const lateExtracted = extractPopupText(popup);
			const lateMatched = findMatchingStructuredNotification(lateExtracted, now);
			if (lateMatched) {
				const lateIsMessage = MESSAGE_NOTIFICATION_TYPES.has(lateMatched.payload.typeId);
				if (!lateIsMessage || isUsableStructuredMessage(lateMatched.payload)) {
					matchedStructuredMessage = lateIsMessage;
					payload = ensureDebugPayload(
						{
							...lateMatched.payload,
							playSound: true,
						},
						`late_matched:${lateMatched.source}`
					);
					console.info(`[steam-native-toasts] Late structured match recovered ${summarizePayload(payload)}`);
				} else {
					console.info(`[steam-native-toasts] Late structured match stayed generic; ignoring ${summarizePayload(lateMatched.payload)}`);
				}
			}

			if (!payload && lateExtracted.usable) {
				payload = ensureDebugPayload(buildPopupFallbackPayload(lateExtracted, lateMatched?.payload ?? matched?.payload), 'late_popup_fallback');
				console.info(`[steam-native-toasts] Late popup fallback recovered ${summarizePayload(payload)}`);
			}
		}

		if (!payload) {
			tracePipeline('handle_popup no_payload');
			console.info('[steam-native-toasts] No usable payload found; leaving Steam popup visible');
			return;
		}

		payload = await resolveIncomingVoicePayloadWithRetries(payload, extracted);

		if (payload.typeId === EClientNotificationType.IncomingVoiceChat && !isUsableStructuredMessage(payload)) {
			console.info('[steam-native-toasts] Incoming voice payload unresolved after retries; using emergency fallback and keeping Steam popup visible');
			payload = buildIncomingVoiceEmergencyFallback(payload);
		}
		if (payload.typeId === EClientNotificationType.GroupChatMessage) {
			payload = {
				...payload,
				body: normalizeGroupChatBodyText(payload.body),
			};
		}
		if (payload.typeId === EClientNotificationType.DownloadComplete && extracted.usable) {
			const popupAppName = extractDownloadCompleteAppNameFromText(extracted.body);
			if (popupAppName) {
				payload = {
					...payload,
					title: 'Download Complete',
					body: `Your game "${popupAppName}" is ready to play`,
				};
			}
		}
		// Keep these normalizers scoped and ordered. Most past regressions came
		// from one notification type "fixing" another type's title/body.
		payload = normalizeVoiceInvitePayload(payload);
		payload = normalizeSocialPopupFallbackPayload(payload);
		payload = normalizeFriendMessagePayload(payload);
		payload = normalizeFriendOnlinePayload(payload);
		payload = normalizeDuplicateLabelArtifacts(payload);
		payload = normalizeDownloadCompletePayload(payload);
		rememberGroupChatContext(payload, now);

		const noiseReason = shouldDropPayloadAsNoise(payload);
		if (noiseReason) {
			tracePipeline(`drop_noise trace=${payload.debugTraceId ?? 'none'} reason=${noiseReason} type=${payload.typeName}`);
			console.info(`[steam-native-toasts] Dropped noisy payload reason=${noiseReason} ${summarizePayload(payload)}`);
			return;
		}

		if (!matchedStructuredMessage && MESSAGE_NOTIFICATION_TYPES.has(payload.typeId) && !isUsableStructuredMessage(payload)) {
			console.info('[steam-native-toasts] Skipped chat fallback because structured message content was unavailable');
			return;
		}

		if (shouldSkipDuplicateForward(payload, now)) {
			console.info(`[steam-native-toasts] Skipping duplicate ${summarizePayload(payload)}`);
			suppressNow();
			return;
		}

		// When users enable popup hiding, treat it as an explicit preference:
		// hide Steam's popup for every payload we are about to forward.
		if (runtimeConfig.hideSteamToast) {
			suppressNow();
		}

		const forwarded = await forwardPayload(payload);
		if (runtimeConfig.hideSteamToast && forwarded && !keepSuppressed) {
			suppressNow();
		}
	} catch (error) {
		console.error('[steam-native-toasts] Failed to process popup', error);
	} finally {
		if (suppressionHandle && !keepSuppressed) {
			suppressionHandle.restore();
		}
	}
};

const initBridge = async (): Promise<void> => {
	if (bridgeInitialized) {
		return;
	}

	bridgeInitialized = true;
	runtimeConfig = readConfig();
	console.info('[steam-native-toasts] Frontend startup');
	refreshGlobalNotificationSuppression();
	beginStartupWarmupSuppression();

	try {
		await (window as unknown as { App?: { WaitForServicesInitialized?: () => Promise<void> } }).App?.WaitForServicesInitialized?.();
		await sleep(100);
		startStructuredCapture();

		for (let i = 0; i < 120; i += 1) {
			if ((window as unknown as { g_PopupManager?: unknown }).g_PopupManager) {
				break;
			}
			await sleep(100);
		}

		const popupManager = (window as unknown as { g_PopupManager?: { AddPopupCreatedCallback?: (cb: (popup: unknown) => void) => void } }).g_PopupManager;
		if (!popupManager?.AddPopupCreatedCallback) {
			console.warn('[steam-native-toasts] Popup manager unavailable; bridge not installed');
			return;
		}

		popupManager.AddPopupCreatedCallback((popup: unknown) => {
			void handlePopupCreated(popup);
		});

		console.info('[steam-native-toasts] Notification popup bridge installed');
	} catch (error) {
		console.error('[steam-native-toasts] Bridge initialization failed', error);
	}
};

const sendTestToast = (): void => {
	const payload: NativeToastPayload = {
		typeId: EClientNotificationType.General,
		typeName: 'General',
		title: 'Steam',
		body: 'Native toast bridge is active.',
		playSound: true,
		debugSource: 'test_button',
	};

	void forwardPayload(payload);
};

const ToggleRow = ({
	label,
	description,
	value,
	onChange,
}: {
	label: string;
	description: string;
	value: boolean;
	onChange: (next: boolean) => void;
}) => {
	const reactApi = (window as unknown as { SP_REACT?: { useState?: <T>(initial: T) => [T, (next: T) => void] } }).SP_REACT;
	const useState = reactApi?.useState;

	if (!useState) {
		return null;
	}

	const [checked, setChecked] = useState<boolean>(value);

	return (
		<Field label={label} description={description} bottomSeparator="standard" focusable>
			<Toggle
				value={checked}
				onChange={(next: boolean) => {
					setChecked(next);
					onChange(next);
				}}
			/>
		</Field>
	);
};

const PRIORITY_MODE_OPTIONS = [
	{ data: PRIORITY_MODE.NONE, label: 'None (Respect DND)' },
	{ data: PRIORITY_MODE.ALL, label: 'Show All Toasts (Priority)' },
	{ data: PRIORITY_MODE.IMPORTANT_ONLY, label: 'Important Only (Priority)' },
];

const DropdownRow = ({
	label,
	description,
	value,
	onChange,
}: {
	label: string;
	description: string;
	value: PriorityMode;
	onChange: (next: PriorityMode) => void;
}) => (
	<Field label={label} description={description} bottomSeparator="standard" focusable>
		<Dropdown
			rgOptions={PRIORITY_MODE_OPTIONS}
			selectedOption={value}
			onChange={(selected) => {
				const next = selected?.data;
				if (next === PRIORITY_MODE.NONE || next === PRIORITY_MODE.ALL || next === PRIORITY_MODE.IMPORTANT_ONLY) {
					onChange(next);
				}
			}}
		/>
	</Field>
);

const SettingsContent = () => (
	<>
		<ToggleRow
			label="Enable Native Toast Bridge"
			description="Forward Steam notification popups to Windows notifications native toasts."
			value={runtimeConfig.enabled}
			onChange={(enabled) => {
				writeConfig({ ...runtimeConfig, enabled });
			}}
		/>
		<ToggleRow
			label="Hide Steam notification Popup"
			description="Hide Steam's own notification popup after forwarding to Windows notifications native toasts."
			value={runtimeConfig.hideSteamToast}
			onChange={(hideSteamToast) => {
				writeConfig({ ...runtimeConfig, hideSteamToast });
			}}
		/>
		<DropdownRow
			label="Priority Mode"
			description="Choose which toasts can bypass Windows Do Not Disturb: none, all, or only important alerts (calls/invites/tutorial prompts)."
			value={runtimeConfig.priorityMode}
			onChange={(priorityMode) => {
				writeConfig({ ...runtimeConfig, priorityMode });
			}}
		/>
		<Field label="Test Native Toast" description="Send a sample Windows toast to verify the bridge." bottomSeparator="standard" focusable>
			<DialogButton onClick={sendTestToast}>Send Test Native Toast</DialogButton>
		</Field>
	</>
);

export default definePlugin(async () => {
	void initBridge();

	return {
		title: 'SteamWindowsToastNotification',
		icon: <IconsModule.Settings />,
		content: <SettingsContent />,
	};
});
