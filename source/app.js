
const electron = require('electron');
const updater = require('electron-updater');
const fs = require('fs'); // 파일 시스템 
const os = require('os');
const path = require('path');
const process = require('process');
const url = require('url');
const base = require('./base');

var app = {};

app.Application = class {

    constructor() {
        this._views = new app.ViewCollection(this);
        this._configuration = new app.ConfigurationService();
        this._menu = new app.MenuService(this._views);
        this._openQueue = [];
        this._package = {};
    }

    start() {
        // package.json 파일의 경로를 가져옵니다.
        const packageFile = path.join(path.dirname(__dirname), 'package.json');
        // package.json 파일의 내용을 동기적으로 읽어옵니다.
        const packageContent = fs.readFileSync(packageFile, 'utf-8');
        // package.json 파일의 내용을 JSON 객체로 파싱하여 _package 변수에 저장합니다.
        this._package = JSON.parse(packageContent);

        // 애플리케이션의 사용자 모델 ID를 설정합니다.
        electron.app.setAppUserModelId('com.lutzroeder.netron');
        // 렌더러 프로세스 재사용을 허용합니다.
        electron.app.allowRendererProcessReuse = true;
        // 애플리케이션이 이미 실행 중인 경우, 새로운 인스턴스를 시작하지 않고 종료합니다.
        if (!electron.app.requestSingleInstanceLock()) {
            electron.app.quit();
            return;
        }

        // 두 번째 인스턴스가 시작될 때의 이벤트 핸들러를 설정합니다.
        electron.app.on('second-instance', (event, commandLine, workingDirectory) => {
            // 현재 작업 디렉토리를 저장하고, 새로운 작업 디렉토리로 변경합니다.
            const currentDirectory = process.cwd();
            process.chdir(workingDirectory);

            // 명령줄을 파싱합니다.
            const open = this._parseCommandLine(commandLine);
            // 작업 디렉토리를 원래대로 복구합니다.
            process.chdir(currentDirectory);
            // 뷰가 존재하지 않는 경우, 첫 번째 뷰를 복원합니다.
            if (!open && !this._views.empty) {
                const view = this._views.first();
                if (view) {
                    view.restore();
                }
            }
        });
        // 'get-environment' 이벤트 핸들러: 현재 애플리케이션의 환경 정보를 반환합니다.
        electron.ipcMain.on('get-environment', (event) => {
            event.returnValue = this.environment;
        });
        // 'get-configuration' 이벤트 핸들러: 요청된 설정의 값을 반환합니다.
        electron.ipcMain.on('get-configuration', (event, obj) => {
            event.returnValue = this._configuration.has(obj.name) ? this._configuration.get(obj.name) : undefined;
        });
        // 'set-configuration' 이벤트 핸들러: 주어진 설정 값을 저장하고 설정을 업데이트합니다.
        electron.ipcMain.on('set-configuration', (event, obj) => {
            this._configuration.set(obj.name, obj.value);
            this._configuration.save();
            event.returnValue = null;
        });
        // 'delete-configuration' 이벤트 핸들러: 주어진 설정을 삭제하고 설정을 업데이트합니다.
        electron.ipcMain.on('delete-configuration', (event, obj) => {
            this._configuration.delete(obj.name);
            this._configuration.save();
            event.returnValue = null;
        });
        // 'drop-paths' 이벤트 핸들러: 주어진 경로의 파일 또는 디렉토리를 엽니다.
        electron.ipcMain.on('drop-paths', (event, data) => {
            const paths = data.paths.filter((path) => {
                if (fs.existsSync(path)) {
                    const stat = fs.statSync(path);
                    return stat.isFile() || stat.isDirectory();
                }
                return false;
            });
            this._dropPaths(event.sender, paths);
            event.returnValue = null;
        });
        // 'show-message-box' 이벤트 핸들러: 메시지 박스를 표시합니다.
        electron.ipcMain.on('show-message-box', (event, options) => {
            const owner = event.sender.getOwnerBrowserWindow();
            event.returnValue = electron.dialog.showMessageBoxSync(owner, options);
        });
        // 'show-save-dialog' 이벤트 핸들러: 저장 대화 상자를 표시합니다.
        electron.ipcMain.on('show-save-dialog', (event, options) => {
            const owner = event.sender.getOwnerBrowserWindow();
            event.returnValue = electron.dialog.showSaveDialogSync(owner, options);
        });
        // 'execute' 이벤트 핸들러: 주어진 명령을 실행합니다.
        electron.ipcMain.on('execute', (event, data) => {
            const owner = event.sender.getOwnerBrowserWindow();
            this.execute(data.name, data.value || null, owner);
            event.returnValue = null;
        });
        // 애플리케이션이 완전히 로딩될 준비가 되면 파일을 엽니다.
        electron.app.on('will-finish-launching', () => {
            electron.app.on('open-file', (event, path) => {
                this._openPath(path);
            });
        });
        // 애플리케이션이 준비되면 _ready 메소드를 호출합니다.
        electron.app.on('ready', () => {
            this._ready();
        });
        // 모든 윈도우가 닫히면, macOS를 제외한 모든 플랫폼에서 애플리케이션을 종료합니다.
        electron.app.on('window-all-closed', () => {
            if (process.platform !== 'darwin') {
                electron.app.quit();
            }
        });
        // 애플리케이션이 종료될 때 설정을 저장합니다.
        electron.app.on('will-quit', () => {
            this._configuration.save();
        });
        // 명령줄을 파싱하고 업데이트를 확인합니다.
        this._parseCommandLine(process.argv);
        this._checkForUpdates();
    }

    get environment() {
        this._environment = this._environment || {
            packaged: electron.app.isPackaged,
            name: this._package.productName,
            version: this._package.version,
            date: this._package.date,
            repository: 'https://github.com/' + this._package.repository,
            platform: process.platform,
            separator: path.sep,
            titlebar: true // process.platform === 'darwin'
        };
        return this._environment;
    }

    _parseCommandLine(argv) {
        // open 변수를 false로 초기화합니다.
        let open = false;
        // argv의 길이가 1보다 큰 경우, 즉 인자가 하나 이상 주어진 경우에만 다음의 로직을 수행합니다.
        if (argv.length > 1) {
            // argv의 첫 번째 인자를 제외한 나머지 인자들에 대해 반복합니다.
            for (const arg of argv.slice(1)) {
                // 인자가 '-'로 시작하지 않고, 현재 디렉토리의 경로와도 일치하지 않는 경우에만 다음의 로직을 수행합니다.
                if (!arg.startsWith('-') && arg !== path.dirname(__dirname)) {
                    // 인자의 확장자를 소문자로 변환합니다.
                    const extension = path.extname(arg).toLowerCase();
                    // 확장자가 비어있지 않고, '.js'가 아니며, 해당 경로의 파일이나 디렉토리가 실제로 존재하는 경우에만 다음의 로직을 수행합니다.
                    if (extension !== '' && extension !== '.js' && fs.existsSync(arg)) {
                        // 해당 경로의 파일이나 디렉토리의 상태를 가져옵니다.
                        const stat = fs.statSync(arg);
                        // 해당 경로가 파일이나 디렉토리를 가리키는 경우에만 다음의 로직을 수행합니다.
                        if (stat.isFile() || stat.isDirectory()) {
                            // 해당 경로를 엽니다.
                            this._openPath(arg);
                            // open 변수를 true로 설정합니다.
                            open = true;
                        }
                    }
                }
            }
        }
        // open 변수를 반환합니다.
        return open;
    }

    _ready() {
        this._configuration.load();
        if (this._openQueue) {
            const queue = this._openQueue;
            this._openQueue = null;
            while (queue.length > 0) {
                const file = queue.shift();
                this._openPath(file);
            }
        }
        if (this._views.empty) {
            this._views.openView();
        }
        this._updateMenu();
        this._views.on('active-view-changed', () => {
            this._menu.update();
        });
        this._views.on('active-view-updated', () => {
            this._menu.update();
        });
    }

    _open(path) {
        // path가 주어지면 그것을 배열로 변환하고, 그렇지 않으면 빈 배열을 생성합니다.
        let paths = path ? [ path ] : [];
        // paths 배열이 비어있는 경우, 즉 path가 주어지지 않은 경우에만 다음의 로직을 수행합니다.
        if (paths.length === 0) {
            // 지원하는 파일 확장자를 가져옵니다.
            const extensions = new base.Metadata().extensions;
            // 파일 열기 대화 상자의 옵션을 설정합니다.
            const showOpenDialogOptions = {
                properties: [ 'openFile' ],
                filters: [ { name: 'All Model Files', extensions: extensions } ]
            };
            // 파일 열기 대화 상자를 동기적으로 표시하고, 사용자가 선택한 파일의 경로를 가져옵니다.
            paths = electron.dialog.showOpenDialogSync(showOpenDialogOptions);
        }
        // paths가 배열이고, 그 길이가 0보다 큰 경우, 즉 사용자가 하나 이상의 파일을 선택한 경우에만 다음의 로직을 수행합니다.
        if (Array.isArray(paths) && paths.length > 0) {
            for (const path of paths) {
                // 각 파일의 경로를 엽니다.
                this._openPath(path);
            }
        }
    }

    _openPath(path) {
        // 만약 _openQueue가 존재하면, path를 _openQueue에 추가하고 함수를 종료합니다.
        if (this._openQueue) {
            this._openQueue.push(path);
            return;
        }
        // path가 존재하고 길이가 0보다 큰 경우, 다음 로직을 수행합니다.
        if (path && path.length > 0) {
            // path가 실제로 존재하는지 확인합니다.
            const exists = fs.existsSync(path);
            if (exists) {
                // path의 상태를 확인합니다. (파일인지 디렉토리인지)
                const stat = fs.statSync(path);
                if (stat.isFile() || stat.isDirectory()) {
                    const views = Array.from(this._views.views);
                    // find existing view for this file
                    let view = views.find(view => view.match(path));
                    // find empty welcome window
                    if (view == null) {
                        view = views.find(view => view.match(null));
                    }
                    // create new window
                    if (view == null) {
                        view = this._views.openView();
                    }
                    // view를 이용하여 path를 엽니다.
                    view.open(path);
                }
            }
            // 최근 열린 파일 목록을 업데이트합니다. path가 존재하지 않는다면 undefined를 전달합니다.
            this._updateRecents(exists ? path : undefined);
        }
    }

    _dropPaths(sender, paths) {
        const window = sender.getOwnerBrowserWindow();
        let view = this._views.get(window);
        for (const path of paths) {
            if (view) {
                view.open(path);
                this._updateRecents(path);
                view = null;
            } else {
                this._openPath(path);
            }
        }
    }

    _export() {
        const view = this._views.activeView;
        if (view && view.path) {
            let defaultPath = 'Untitled';
            const file = view.path;
            const lastIndex = file.lastIndexOf('.');
            if (lastIndex !== -1) {
                defaultPath = file.substring(0, lastIndex);
            }
            const owner = electron.BrowserWindow.getFocusedWindow();
            const showSaveDialogOptions = {
                title: 'Export',
                defaultPath: defaultPath,
                buttonLabel: 'Export',
                filters: [
                    { name: 'PNG', extensions: [ 'png' ] },
                    { name: 'SVG', extensions: [ 'svg' ] }
                ]
            };
            const selectedFile = electron.dialog.showSaveDialogSync(owner, showSaveDialogOptions);
            if (selectedFile) {
                view.execute('export', { 'file': selectedFile });
            }
        }
    }

    execute(command, value, window) {
        switch (command) {
            case 'open': this._open(value); break;
            case 'export': this._export(); break;
            case 'close': window.close(); break;
            case 'quit': electron.app.quit(); break;
            case 'reload': this._reload(); break;
            case 'report-issue': electron.shell.openExternal('https://github.com/' + this._package.repository + '/issues/new'); break;
            case 'about': this._about(); break;
            default: {
                const view = this._views.get(window) || this._views.activeView;
                if (view) {
                    view.execute(command, value || {});
                }
                this._menu.update();
            }
        }
    }

    _reload() {
        const view = this._views.activeView;
        if (view && view.path) {
            view.open(view.path);
            this._updateRecents(view.path);
        }
    }

    _checkForUpdates() {
        if (!electron.app.isPackaged) {
            return;
        }
        const autoUpdater = updater.autoUpdater;
        if (autoUpdater.app && autoUpdater.app.appUpdateConfigPath && !fs.existsSync(autoUpdater.app.appUpdateConfigPath)) {
            return;
        }
        const promise = autoUpdater.checkForUpdates();
        if (promise) {
            promise.catch((error) => {
                /* eslint-disable no-console */
                console.log(error.message);
                /* eslint-enable no-console */
            });
        }
    }

    _about() {
        let view = this._views.activeView;
        if (view == null) {
            view = this._views.openView();
        }
        view.execute('about');
    }

    _updateRecents(path) {
        let updated = false;
        let recents = this._configuration.has('recents') ? this._configuration.get('recents') : [];
        if (path && (recents.length === 0 || recents[0] !== path)) {
            recents = recents.filter((recent) => path !== recent);
            recents.unshift(path);
            updated = true;
        }
        const value = [];
        for (const recent of recents) {
            if (value.length >= 9) {
                updated = true;
                break;
            }
            if (!fs.existsSync(recent)) {
                updated = true;
                continue;
            }
            const stat = fs.statSync(recent);
            if (!stat.isFile() && !stat.isDirectory()) {
                updated = true;
                continue;
            }
            value.push(recent);
        }
        if (updated) {
            this._configuration.set('recents', value);
            this._updateMenu();
        }
    }

    _updateMenu() {

        let recents = [];
        if (this._configuration.has('recents')) {
            const value = this._configuration.get('recents');
            recents = value.map((recent) => app.Application.location(recent));
        }

        if (this.environment.titlebar && recents.length > 0) {
            for (const view of this._views.views) {
                view.execute('recents', recents);
            }
        }

        const darwin = process.platform === 'darwin';
        if (!this.environment.titlebar || darwin) {
            const menuRecentsTemplate = [];
            for (let i = 0; i < recents.length; i++) {
                const recent = recents[i];
                menuRecentsTemplate.push({
                    path: recent.path,
                    label: recent.label,
                    accelerator: (darwin ? 'Cmd+' : 'Ctrl+') + (i + 1).toString(),
                    click: (item) => this._openPath(item.path)
                });
            }

            const menuTemplate = [];

            if (darwin) {
                menuTemplate.unshift({
                    label: electron.app.name,
                    submenu: [
                        {
                            label: 'About ' + electron.app.name,
                            click: () => /* this.execute('about', null) */ this._about()
                        },
                        { type: 'separator' },
                        { role: 'hide' },
                        { role: 'hideothers' },
                        { role: 'unhide' },
                        { type: 'separator' },
                        { role: 'quit' }
                    ]
                });
            }

            menuTemplate.push({
                label: '&File',
                submenu: [
                    {
                        label: '&Open...',
                        accelerator: 'CmdOrCtrl+O',
                        click: () => this._open(null)
                    },
                    {
                        label: 'Open &Recent',
                        submenu: menuRecentsTemplate
                    },
                    { type: 'separator' },
                    {
                        id: 'file.export',
                        label: '&Export...',
                        accelerator: 'CmdOrCtrl+Shift+E',
                        click: () => this.execute('export', null)
                    },
                    { type: 'separator' },
                    { role: 'close' },
                ]
            });

            if (!darwin) {
                menuTemplate.slice(-1)[0].submenu.push(
                    { type: 'separator' },
                    { role: 'quit' }
                );
            }

            if (darwin) {
                electron.systemPreferences.setUserDefault('NSDisabledDictationMenuItem', 'boolean', true);
                electron.systemPreferences.setUserDefault('NSDisabledCharacterPaletteMenuItem', 'boolean', true);
            }

            menuTemplate.push({
                label: '&Edit',
                submenu: [
                    {
                        id: 'edit.cut',
                        label: 'Cu&t',
                        accelerator: 'CmdOrCtrl+X',
                        click: () => this.execute('cut', null),
                    },
                    {
                        id: 'edit.copy',
                        label: '&Copy',
                        accelerator: 'CmdOrCtrl+C',
                        click: () => this.execute('copy', null),
                    },
                    {
                        id: 'edit.paste',
                        label: '&Paste',
                        accelerator: 'CmdOrCtrl+V',
                        click: () => this.execute('paste', null),
                    },
                    {
                        id: 'edit.select-all',
                        label: 'Select &All',
                        accelerator: 'CmdOrCtrl+A',
                        click: () => this.execute('selectall', null),
                    },
                    { type: 'separator' },
                    {
                        id: 'edit.find',
                        label: '&Find...',
                        accelerator: 'CmdOrCtrl+F',
                        click: () => this.execute('find', null),
                    }
                ]
            });

            const viewTemplate = {
                label: '&View',
                submenu: [
                    {
                        id: 'view.toggle-attributes',
                        accelerator: 'CmdOrCtrl+D',
                        click: () => this.execute('toggle', 'attributes'),
                    },
                    {
                        id: 'view.toggle-weights',
                        accelerator: 'CmdOrCtrl+I',
                        click: () => this.execute('toggle', 'weights'),
                    },
                    {
                        id: 'view.toggle-names',
                        accelerator: 'CmdOrCtrl+U',
                        click: () => this.execute('toggle', 'names'),
                    },
                    {
                        id: 'view.toggle-direction',
                        accelerator: 'CmdOrCtrl+K',
                        click: () => this.execute('toggle', 'direction')
                    },
                    {
                        id: 'view.toggle-mousewheel',
                        accelerator: 'CmdOrCtrl+M',
                        click: () => this.execute('toggle', 'mousewheel'),
                    },
                    { type: 'separator' },
                    {
                        id: 'view.reload',
                        label: '&Reload',
                        accelerator: darwin ? 'Cmd+R' : 'F5',
                        click: () => this._reload(),
                    },
                    { type: 'separator' },
                    {
                        id: 'view.reset-zoom',
                        label: 'Actual &Size',
                        accelerator: 'Shift+Backspace',
                        click: () => this.execute('reset-zoom', null),
                    },
                    {
                        id: 'view.zoom-in',
                        label: 'Zoom &In',
                        accelerator: 'Shift+Up',
                        click: () => this.execute('zoom-in', null),
                    },
                    {
                        id: 'view.zoom-out',
                        label: 'Zoom &Out',
                        accelerator: 'Shift+Down',
                        click: () => this.execute('zoom-out', null),
                    },
                    { type: 'separator' },
                    {
                        id: 'view.show-properties',
                        label: '&Properties...',
                        accelerator: 'CmdOrCtrl+Enter',
                        click: () => this.execute('show-properties', null),
                    }
                ]
            };
            if (!electron.app.isPackaged) {
                viewTemplate.submenu.push({ type: 'separator' });
                viewTemplate.submenu.push({ role: 'toggledevtools' });
            }
            menuTemplate.push(viewTemplate);

            if (darwin) {
                menuTemplate.push({
                    role: 'window',
                    submenu: [
                        { role: 'minimize' },
                        { role: 'zoom' },
                        { type: 'separator' },
                        { role: 'front' }
                    ]
                });
            }

            const helpSubmenu = [
                {
                    label: 'Report &Issue',
                    click: () => this.execute('report-issue', null)
                }
            ];

            if (!darwin) {
                helpSubmenu.push({ type: 'separator' });
                helpSubmenu.push({
                    label: '&About ' + electron.app.name,
                    click: () => this.execute('about', null)
                });
            }

            menuTemplate.push({
                role: 'help',
                submenu: helpSubmenu
            });

            const commandTable = new Map();
            commandTable.set('file.export', {
                enabled: (view) => view && view.path ? true : false
            });
            commandTable.set('edit.cut', {
                enabled: (view) => view && view.path ? true : false
            });
            commandTable.set('edit.copy', {
                enabled: (view) => view && view.path ? true : false
            });
            commandTable.set('edit.paste', {
                enabled: (view) => view && view.path ? true : false
            });
            commandTable.set('edit.select-all', {
                enabled: (view) => view && view.path ? true : false
            });
            commandTable.set('edit.find', {
                enabled: (view) => view && view.path ? true : false
            });
            commandTable.set('view.toggle-attributes', {
                enabled: (view) => view && view.path ? true : false,
                label: (view) => !view || view.get('attributes') ? 'Hide &Attributes' : 'Show &Attributes'
            });
            commandTable.set('view.toggle-weights', {
                enabled: (view) => view && view.path ? true : false,
                label: (view) => !view || view.get('weights') ? 'Hide &Weights' : 'Show &Weights'
            });
            commandTable.set('view.toggle-names', {
                enabled: (view) => view && view.path ? true : false,
                label: (view) => !view || view.get('names') ? 'Hide &Names' : 'Show &Names'
            });
            commandTable.set('view.toggle-direction', {
                enabled: (view) => view && view.path ? true : false,
                label: (view) => !view || view.get('direction') === 'vertical' ? 'Show &Horizontal' : 'Show &Vertical'
            });
            commandTable.set('view.toggle-mousewheel', {
                enabled: (view) => view && view.path ? true : false,
                label: (view) => !view || view.get('mousewheel') === 'scroll' ? '&Mouse Wheel: Zoom' : '&Mouse Wheel: Scroll'
            });
            commandTable.set('view.reload', {
                enabled: (view) => view && view.path ? true : false
            });
            commandTable.set('view.reset-zoom', {
                enabled: (view) => view && view.path ? true : false
            });
            commandTable.set('view.zoom-in', {
                enabled: (view) => view && view.path ? true : false
            });
            commandTable.set('view.zoom-out', {
                enabled: (view) => view && view.path ? true : false
            });
            commandTable.set('view.show-properties', {
                enabled: (view) => view && view.path ? true : false
            });

            this._menu.build(menuTemplate, commandTable);
            this._menu.update();
        }
    }

    static location(path) {
        if (process.platform !== 'win32') {
            const homeDir = os.homedir();
            if (path.startsWith(homeDir)) {
                return { path: path, label: '~' + path.substring(homeDir.length) };
            }
        }
        return { path: path, label: path };
    }
};

app.View = class {

    constructor(owner) {
        this._owner = owner;
        this._ready = false;
        this._path = null;
        this._properties = new Map();
        this._dispatch = [];
        const size = electron.screen.getPrimaryDisplay().workAreaSize;
        const options = {
            show: false,
            title: electron.app.name,
            backgroundColor: electron.nativeTheme.shouldUseDarkColors ? '#1d1d1d' : '#e6e6e6',
            icon: electron.nativeImage.createFromPath(path.join(__dirname, 'icon.png')),
            minWidth: 600,
            minHeight: 600,
            width: size.width > 1024 ? 1024 : size.width,
            height: size.height > 768 ? 768 : size.height,
            webPreferences: {
                preload: path.join(__dirname, 'electron.js'),
                nodeIntegration: true
            }
        };
        if (owner.application.environment.titlebar) {
            options.frame = false;
            options.thickFrame = true;
            options.titleBarStyle = 'hiddenInset';
        }
        if (!this._owner.empty && app.View._position && app.View._position.length == 2) {
            options.x = app.View._position[0] + 30;
            options.y = app.View._position[1] + 30;
            if (options.x + options.width > size.width) {
                options.x = 0;
            }
            if (options.y + options.height > size.height) {
                options.y = 0;
            }
        }
        this._window = new electron.BrowserWindow(options);
        app.View._position = this._window.getPosition();
        this._window.on('close', () => this._owner.closeView(this));
        this._window.on('focus', () => this.emit('activated'));
        this._window.on('blur', () => this.emit('deactivated'));
        this._window.on('minimize', () => this.state());
        this._window.on('restore', () => this.state());
        this._window.on('maximize', () => this.state());
        this._window.on('unmaximize', () => this.state());
        this._window.on('enter-full-screen', () => this.state('enter-full-screen'));
        this._window.on('leave-full-screen', () => this.state('leave-full-screen'));
        this._window.webContents.on('did-finish-load', () => {
            this._didFinishLoad = true;
        });
        this._window.webContents.setWindowOpenHandler((detail) => {
            const url = detail.url;
            if (url.startsWith('http://') || url.startsWith('https://')) {
                electron.shell.openExternal(url);
            }
            return { action: 'deny' };
        });
        this._window.once('ready-to-show', () => {
            this._window.show();
        });
        if (owner.application.environment.titlebar && process.platform !== 'darwin') {
            this._window.removeMenu();
        }
        this._loadURL();
    }

    get window() {
        return this._window;
    }

    get path() {
        return this._path;
    }

    open(path) {
        this._openPath = path;
        const location = app.Application.location(path);
        if (this._didFinishLoad) {
            this._window.webContents.send('open', location);
        } else {
            this._window.webContents.on('did-finish-load', () => {
                this._window.webContents.send('open', location);
            });
            this._loadURL();
        }
    }

    _loadURL() {
        const pathname = path.join(__dirname, 'index.html');
        let content = fs.readFileSync(pathname, 'utf-8');
        content = content.replace(/<\s*script[^>]*>[\s\S]*?(<\s*\/script[^>]*>|$)/ig, '');
        const data = 'data:text/html;charset=utf-8,' + encodeURIComponent(content);
        const options = {
            baseURLForDataURL: url.pathToFileURL(pathname).toString()
        };
        this._window.loadURL(data, options);
    }

    restore() {
        if (this._window) {
            if (this._window.isMinimized()) {
                this._window.restore();
            }
            this._window.show();
        }
    }

    match(path) {
        if (this._openPath) {
            return this._openPath === path;
        }
        return this._path === path;
    }

    execute(command, data) {
        if (this._dispatch) {
            this._dispatch.push({ command: command, data: data });
        } else if (this._window && this._window.webContents) {
            const window = this._window;
            const contents = window.webContents;
            switch (command) {
                case 'toggle-developer-tools':
                    if (contents.isDevToolsOpened()) {
                        contents.closeDevTools();
                    } else {
                        contents.openDevTools();
                    }
                    break;
                case 'fullscreen':
                    window.setFullScreen(!window.isFullScreen());
                    break;
                default:
                    contents.send(command, data);
                    break;
            }
        }
    }

    update(data) {
        for (const entry of Object.entries(data)) {
            const name = entry[0];
            const value = entry[1];
            switch (name) {
                case 'path': {
                    if (value) {
                        this._path = value;
                        const location = app.Application.location(this._path);
                        const title = process.platform !== 'darwin' ? location.label + ' - ' + electron.app.name : location.label;
                        this._window.setTitle(title);
                        this._window.focus();
                    }
                    delete this._openPath;
                    break;
                }
                default: {
                    this._properties.set(name, value);
                }
            }
        }
        this.emit('updated');
    }

    get(name) {
        return this._properties.get(name);
    }

    on(event, callback) {
        this._events = this._events || {};
        this._events[event] = this._events[event] || [];
        this._events[event].push(callback);
    }

    emit(event, data) {
        if (this._events && this._events[event]) {
            for (const callback of this._events[event]) {
                callback(this, data);
            }
        }
    }

    state(event) {
        this.execute('window-state', {
            minimized: this._window.isMinimized(),
            maximized: this._window.isMaximized(),
            fullscreen: event === 'enter-full-screen' ? true : event === 'leave-full-screen' ? false : this._window.isFullScreen()
        });
        if (this._dispatch) {
            const dispatch = this._dispatch;
            delete this._dispatch;
            for (const obj of dispatch) {
                this.execute(obj.command, obj.data);
            }
        }
    }
};

app.ViewCollection = class {

    constructor(application) {
        this._application = application;
        this._views = new Map();
        electron.ipcMain.on('window-close', (event) => {
            const window = event.sender.getOwnerBrowserWindow();
            window.close();
            event.returnValue = null;
        });
        electron.ipcMain.on('window-toggle', (event) => {
            const window = event.sender.getOwnerBrowserWindow();
            if (window.isFullScreen()) {
                window.setFullScreen(false);
            } else if (window.isMaximized()) {
                window.unmaximize();
            } else {
                window.maximize();
            }
            event.returnValue = null;
        });
        electron.ipcMain.on('window-minimize', (event) => {
            const window = event.sender.getOwnerBrowserWindow();
            window.minimize();
            event.returnValue = null;
        });
        electron.ipcMain.on('window-update', (event, data) => {
            const window = event.sender.getOwnerBrowserWindow();
            if (this._views.has(window)) {
                this._views.get(window).update(data);
            }
            event.returnValue = null;
        });
        electron.ipcMain.on('update-window-state', (event) => {
            const window = event.sender.getOwnerBrowserWindow();
            if (this._views.has(window)) {
                this._views.get(window).state();
            }
            event.returnValue = null;
        });
    }

    get application() {
        return this._application;
    }

    get views() {
        return this._views.values();
    }

    get empty() {
        return this._views.size === 0;
    }

    get(window) {
        return this._views.get(window);
    }

    openView() {
        const view = new app.View(this);
        view.on('activated', (view) => {
            this._activeView = view;
            this.emit('active-view-changed', { activeView: this._activeView });
        });
        view.on('updated', () => {
            this.emit('active-view-updated', { activeView: this._activeView });
        });
        view.on('deactivated', () => {
            this._activeView = null;
            this.emit('active-view-changed', { activeView: this._activeView });
        });
        this._views.set(view.window, view);
        this._updateActiveView();
        return view;
    }

    closeView(view) {
        this._views.delete(view.window);
        this._updateActiveView();
    }

    first() {
        return this.empty ? null : this._views.values().next().value;
    }

    get activeView() {
        return this._activeView;
    }

    on(event, callback) {
        this._events = this._events || {};
        this._events[event] = this._events[event] || [];
        this._events[event].push(callback);
    }

    emit(event, data) {
        if (this._events && this._events[event]) {
            for (const callback of this._events[event]) {
                callback(this, data);
            }
        }
    }

    _updateActiveView() {
        const window = electron.BrowserWindow.getFocusedWindow();
        const view = window && this._views.has(window) ? this._views.get(window) : null;
        if (view !== this._activeView) {
            this._activeView = view;
            this.emit('active-view-changed', { activeView: this._activeView });
        }
    }
};

app.ConfigurationService = class {

    constructor() {
        const dir = electron.app.getPath('userData');
        if (dir && dir.length > 0) {
            this._file = path.join(dir, 'configuration.json');
        }
    }

    load() {
        this._data = { 'recents': [] };
        if (this._file && fs.existsSync(this._file)) {
            const data = fs.readFileSync(this._file, 'utf-8');
            if (data) {
                try {
                    this._data = JSON.parse(data);
                    if (Array.isArray(this._data.recents)) {
                        this._data.recents = this._data.recents.map((recent) => typeof recent === 'string' ? recent : (recent && recent.path ? recent.path : recent));
                    }
                } catch (error) {
                    // continue regardless of error
                }
            }
        }
    }

    save() {
        if (this._data && this._file) {
            const data = JSON.stringify(this._data, null, 2);
            fs.writeFileSync(this._file, data);
        }
    }

    has(name) {
        return this._data && Object.prototype.hasOwnProperty.call(this._data, name);
    }

    set(name, value) {
        this._data[name] = value;
    }

    get(name) {
        return this._data[name];
    }

    delete(name) {
        delete this._data[name];
    }
};

app.MenuService = class {

    constructor(views) {
        this._views = views;
    }

    build(menuTemplate, commandTable) {
        this._menuTemplate = menuTemplate;
        this._commandTable = commandTable;
        this._itemTable = new Map();
        for (const menu of menuTemplate) {
            for (const item of menu.submenu) {
                if (item.id) {
                    if (!item.label) {
                        item.label = '';
                    }
                    this._itemTable.set(item.id, item);
                }
            }
        }
        this._rebuild();
    }

    update() {
        if (!this._menu && !this._commandTable) {
            return;
        }
        const view = this._views.activeView;
        if (this._updateLabel(view)) {
            this._rebuild();
        }
        this._updateEnabled(view);
    }

    _rebuild() {
        if (process.platform === 'darwin') {
            this._menu = electron.Menu.buildFromTemplate(this._menuTemplate);
            electron.Menu.setApplicationMenu(this._menu);
        } else if (!this._views.application.environment.titlebar) {
            this._menu = electron.Menu.buildFromTemplate(this._menuTemplate);
            for (const view of this._views.views) {
                view.window.setMenu(this._menu);
            }
        }
    }

    _updateLabel(view) {
        let rebuild = false;
        for (const entry of this._commandTable.entries()) {
            if (this._menu) {
                const menuItem = this._menu.getMenuItemById(entry[0]);
                const command = entry[1];
                if (command && command.label) {
                    const label = command.label(view);
                    if (label !== menuItem.label) {
                        if (this._itemTable.has(entry[0])) {
                            this._itemTable.get(entry[0]).label = label;
                            rebuild = true;
                        }
                    }
                }
            }
        }
        return rebuild;
    }

    _updateEnabled(view) {
        for (const entry of this._commandTable.entries()) {
            if (this._menu) {
                const menuItem = this._menu.getMenuItemById(entry[0]);
                const command = entry[1];
                if (menuItem && command.enabled) {
                    menuItem.enabled = command.enabled(view);
                }
            }
        }
    }
};

global.application = new app.Application();
global.application.start();