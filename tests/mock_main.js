export const wm = {
    addKeybinding: () => 100,
    removeKeybinding: () => {},
};

export const layoutManager = {
    primaryMonitor: { x: 0, y: 0, width: 1920, height: 1080 },
    monitors: [{ x: 0, y: 0, width: 1920, height: 1080 }],
    uiGroup: {
        add_child: () => {},
        remove_child: () => {},
    },
};

export function pushModal() {
    return {};
}

export function popModal() {}

export const sessionMode = {
    connect: () => 1,
    disconnect: () => {},
    isLocked: false,
};

