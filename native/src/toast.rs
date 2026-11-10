use windows::core::{Result, HSTRING};
use windows::Data::Xml::Dom::XmlDocument;
use windows::Win32::System::Com::{CoInitializeEx, COINIT_MULTITHREADED};
use windows::UI::Notifications::{ToastNotification, ToastNotificationManager};

pub fn show(xml: &str, app_id: &str, tag: Option<&str>, group: Option<&str>) -> Result<()> {
    unsafe {
        CoInitializeEx(None, COINIT_MULTITHREADED).ok()?;

        let document = XmlDocument::new()?;
        document.LoadXml(&HSTRING::from(xml))?;

        let toast = ToastNotification::CreateToastNotification(&document)?;
        if let Some(tag) = tag {
            toast.SetTag(&HSTRING::from(tag))?;
        }
        if let Some(group) = group {
            toast.SetGroup(&HSTRING::from(group))?;
        }

        let notifier = ToastNotificationManager::CreateToastNotifierWithId(&HSTRING::from(app_id))?;
        notifier.Show(&toast)?;
    }

    Ok(())
}
