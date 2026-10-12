import Adw from 'gi://Adw';
import Gtk from 'gi://Gtk';
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';

const resource = Gio.Resource.load('/usr/share/gnome-shell/org.gnome.Shell.Extensions.src.gresource');
resource._register();
Adw.init();


async function runPrefsSmokeTest() {
    print('=== 开始 Raw Clipboard 设置界面 (prefs.js) 烟雾测试 ===');

    const testDir = GLib.path_get_dirname(GLib.filename_from_uri(import.meta.url)[0]);
    const root = GLib.path_get_dirname(testDir);
    const schemasDir = GLib.build_filenamev([root, 'schemas']);

    const schemaSource = Gio.SettingsSchemaSource.new_from_directory(
        schemasDir,
        Gio.SettingsSchemaSource.get_default(),
        false
    );
    const schema = schemaSource.lookup('org.gnome.shell.extensions.raw-clipboard', false);
    const settings = new Gio.Settings({ settings_schema: schema });

    const prefsModule = await import('../prefs.js');
    const PrefsClass = prefsModule.default;

    const metadata = {
        uuid: 'raw-clipboard@local',
        path: root,
        dir: Gio.File.new_for_path(root),
        'settings-schema': 'org.gnome.shell.extensions.raw-clipboard',
    };

    const prefsInstance = new PrefsClass(metadata);




    // 创建虚拟设置窗口
    const window = new Adw.PreferencesWindow();
    prefsInstance.fillPreferencesWindow(window);

    print('  ✓ PreferencesWindow 构建成功，无异常抛出！');

    // 快捷键加速键组合校验测试
    const Gdk = (await import('gi://Gdk')).default;
    const defaultModMask = Gtk.accelerator_get_default_mod_mask();
    const superMask = defaultModMask & Gdk.ModifierType.SUPER_MASK;
    const accelName = Gtk.accelerator_name_with_keycode(null, Gdk.KEY_v, 55, superMask);
    if (accelName !== '<Super>v') {
        throw new Error(`快捷键生成异常: 期望 '<Super>v', 实际: '${accelName}'`);
    }
    print('  ✓ Super+V 组合加速键名称正确解析为: ' + accelName);

    print('=== prefs.js 烟雾测试通过！ ===');
    imports.system.exit(0);
}

runPrefsSmokeTest().catch(err => {
    printerr('Prefs 测试失败:', err);
    imports.system.exit(1);
});

