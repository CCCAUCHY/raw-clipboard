import Gio from 'gi://Gio';
import GLib from 'gi://GLib';

export class Extension {
    constructor(metadata = {}) {
        this.metadata = metadata;
    }

    getSettings(schema) {
        const cwd = GLib.getenv('RAW_CLIPBOARD_DIR') || GLib.get_current_dir();
        let schemasDir = GLib.build_filenamev([cwd, 'schemas']);
        if (!GLib.file_test(schemasDir, GLib.FileTest.IS_DIR)) {
            schemasDir = GLib.build_filenamev([GLib.path_get_dirname(cwd), 'schemas']);
        }
        const schemaSource = Gio.SettingsSchemaSource.new_from_directory(
            schemasDir,
            Gio.SettingsSchemaSource.get_default(),
            false
        );
        const schemaObj = schemaSource.lookup(schema || 'org.gnome.shell.extensions.raw-clipboard', false);
        return new Gio.Settings({ settings_schema: schemaObj });
    }
}
