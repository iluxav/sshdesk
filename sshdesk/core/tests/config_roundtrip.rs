#[test]
fn settings_writes_for_several_apps_accumulate() {
    use sshdesk_core::config::{Flat, parse, render};
    let mut flat = Flat::new();
    for (k, v) in [
        ("icons.ports.app", "lucide:ethernet-port"),
        ("icons.systemctl.app", "lucide:server-cog"),
        ("icons.system.app", "lucide:cpu"),
        ("theme.desk.accent", "#ef4444"),
    ] {
        flat.insert(k.into(), v.into());
        // Settings re-reads between writes, exactly as config_set does.
        let text = render(&flat);
        flat = parse(&text).unwrap_or_else(|e| panic!("re-read failed after {k}: {e}\n---\n{text}"));
    }
    println!("{}", render(&flat));
    assert_eq!(flat.len(), 4, "keys lost: {flat:?}");
}
