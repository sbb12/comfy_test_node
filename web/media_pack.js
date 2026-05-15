import { app } from "../../scripts/app.js";

const NODE_NAMES = new Set(["StringNumberListItem", "sx_string_number_list_item"]);
const ROW_COUNT = 20;
const ROW_WIDGET_RE = /^row_(\d+)_(string|number)$/;
const HIDDEN_SIZE = [0, -4];

function isTargetNode(node) {
    return (
        NODE_NAMES.has(node.comfyClass) ||
        NODE_NAMES.has(node.constructor?.comfyClass) ||
        NODE_NAMES.has(node.type) ||
        NODE_NAMES.has(node.title)
    );
}

function rowIndexFromName(name) {
    const match = name?.match(ROW_WIDGET_RE);
    return match ? Number(match[1]) : null;
}

function ensureStore(node) {
    if (!node._mp) {
        node._mp = {
            hiddenWidgets: new Map(), // name -> widget
            hiddenInputs: new Map(),  // name -> { input, index }
            wired: new Set(),
        };
    }
    return node._mp;
}

function allWidgetsAndInputs(node) {
    // Union of currently-visible widgets and any we've hidden away.
    const store = ensureStore(node);
    const widgets = new Map();
    for (const widget of node.widgets ?? []) {
        if (widget?.name) widgets.set(widget.name, widget);
    }
    for (const [name, widget] of store.hiddenWidgets) widgets.set(name, widget);

    const inputs = new Map();
    for (const input of node.inputs ?? []) {
        if (input?.name) inputs.set(input.name, input);
    }
    for (const [name, { input }] of store.hiddenInputs) inputs.set(name, input);

    return { widgets, inputs };
}

function rowStringValue(node, rowIndex) {
    const { widgets } = allWidgetsAndInputs(node);
    const widget = widgets.get(`row_${rowIndex}_string`);
    return String(widget?.value ?? "").trim();
}

function visibleRowCount(node) {
    let visible = 1;
    for (let i = 0; i < ROW_COUNT - 1; i++) {
        if (!rowStringValue(node, i)) break;
        visible = i + 2;
    }
    return Math.min(visible, ROW_COUNT);
}

function hideWidget(node, name) {
    const store = ensureStore(node);
    if (store.hiddenWidgets.has(name)) return;
    const idx = node.widgets?.findIndex((w) => w?.name === name) ?? -1;
    if (idx < 0) return;
    const [widget] = node.widgets.splice(idx, 1);
    store.hiddenWidgets.set(name, widget);
    for (const el of [widget.element, widget.inputEl, widget.domElement]) {
        if (el?.style) {
            el._mp_prevDisplay = el.style.display;
            el.style.display = "none";
        }
    }
}

function showWidget(node, name) {
    const store = ensureStore(node);
    const widget = store.hiddenWidgets.get(name);
    if (!widget) return;
    store.hiddenWidgets.delete(name);
    if (!node.widgets) node.widgets = [];
    // Reinsert preserving original row order: append, then sort below.
    node.widgets.push(widget);
    for (const el of [widget.element, widget.inputEl, widget.domElement]) {
        if (el?.style) el.style.display = el._mp_prevDisplay ?? "";
    }
}

function hideInput(node, name) {
    const store = ensureStore(node);
    if (store.hiddenInputs.has(name)) return;
    const idx = node.inputs?.findIndex((i) => i?.name === name) ?? -1;
    if (idx < 0) return;
    const [input] = node.inputs.splice(idx, 1);
    store.hiddenInputs.set(name, { input, index: idx });
}

function showInput(node, name) {
    const store = ensureStore(node);
    const entry = store.hiddenInputs.get(name);
    if (!entry) return;
    store.hiddenInputs.delete(name);
    if (!node.inputs) node.inputs = [];
    const insertAt = Math.min(entry.index, node.inputs.length);
    node.inputs.splice(insertAt, 0, entry.input);
}

function sortWidgetsByOriginalOrder(node) {
    if (!node.widgets) return;
    const baseOrder = (name) => {
        const rowIdx = rowIndexFromName(name);
        if (rowIdx === null) return -1; // base widgets stay above rows
        const isNumber = name.endsWith("_number") ? 1 : 0;
        return rowIdx * 2 + isNumber;
    };
    node.widgets.sort((a, b) => {
        const ai = baseOrder(a.name);
        const bi = baseOrder(b.name);
        if (ai === -1 && bi === -1) return 0;
        if (ai === -1) return -1;
        if (bi === -1) return 1;
        return ai - bi;
    });
}

function sortInputsByOriginalOrder(node) {
    if (!node.inputs) return;
    const order = (name) => {
        const rowIdx = rowIndexFromName(name);
        if (rowIdx === null) return -1;
        const isNumber = name.endsWith("_number") ? 1 : 0;
        return rowIdx * 2 + isNumber;
    };
    node.inputs.sort((a, b) => {
        const ai = order(a.name);
        const bi = order(b.name);
        if (ai === -1 && bi === -1) return 0;
        if (ai === -1) return -1;
        if (bi === -1) return 1;
        return ai - bi;
    });
}

function refreshRows(node) {
    if (!isTargetNode(node)) return;

    const visible = visibleRowCount(node);

    for (let i = 0; i < ROW_COUNT; i++) {
        const stringName = `row_${i}_string`;
        const numberName = `row_${i}_number`;
        if (i < visible) {
            showWidget(node, stringName);
            showWidget(node, numberName);
            showInput(node, stringName);
            showInput(node, numberName);
        } else {
            hideWidget(node, stringName);
            hideWidget(node, numberName);
            hideInput(node, stringName);
            hideInput(node, numberName);
        }
    }

    sortWidgetsByOriginalOrder(node);
    sortInputsByOriginalOrder(node);

    node.setSize?.(node.computeSize());
    app.graph?.setDirtyCanvas(true, true);
}

function scheduleRefresh(node) {
    if (node._mp_refreshPending) return;
    node._mp_refreshPending = true;
    requestAnimationFrame(() => {
        node._mp_refreshPending = false;
        refreshRows(node);
    });
}

function widgetInputElement(widget) {
    for (const candidate of [widget.inputEl, widget.element, widget.domElement]) {
        if (!candidate) continue;
        if (["TEXTAREA", "INPUT"].includes(candidate.tagName)) return candidate;
        const found = candidate.querySelector?.("textarea,input");
        if (found) return found;
    }
    return null;
}

function wireWidget(node, widget) {
    const store = ensureStore(node);
    if (!widget || store.wired.has(widget)) return;
    store.wired.add(widget);

    const original = widget.callback;
    widget.callback = function (...args) {
        const result = original?.apply(this, args);
        scheduleRefresh(node);
        return result;
    };

    const input = widgetInputElement(widget);
    if (input) {
        const handler = () => {
            widget.value = input.value;
            scheduleRefresh(node);
        };
        for (const event of ["input", "change", "keyup", "paste"]) {
            input.addEventListener(event, handler);
        }
    }
}

function wireAllStringWidgets(node) {
    const { widgets } = allWidgetsAndInputs(node);
    for (const [name, widget] of widgets) {
        if (name.endsWith("_string")) wireWidget(node, widget);
    }
}

function restoreAllForSerialization(node) {
    const store = ensureStore(node);
    const hiddenWidgetNames = [...store.hiddenWidgets.keys()];
    const hiddenInputNames = [...store.hiddenInputs.keys()];
    for (const name of hiddenWidgetNames) showWidget(node, name);
    for (const name of hiddenInputNames) showInput(node, name);
    sortWidgetsByOriginalOrder(node);
    sortInputsByOriginalOrder(node);
}

function patch(node) {
    if (!isTargetNode(node)) return;
    wireAllStringWidgets(node);
    refreshRows(node);
    setTimeout(() => {
        wireAllStringWidgets(node);
        refreshRows(node);
    }, 150);
}

app.registerExtension({
    name: "MediaPack.StringNumberListItem",
    beforeRegisterNodeDef(nodeType, nodeData) {
        if (!NODE_NAMES.has(nodeData.name) && !NODE_NAMES.has(nodeData.display_name)) {
            return;
        }

        const onNodeCreated = nodeType.prototype.onNodeCreated;
        nodeType.prototype.onNodeCreated = function (...args) {
            const result = onNodeCreated?.apply(this, args);
            requestAnimationFrame(() => patch(this));
            return result;
        };

        const onConfigure = nodeType.prototype.onConfigure;
        nodeType.prototype.onConfigure = function (...args) {
            const result = onConfigure?.apply(this, args);
            requestAnimationFrame(() => patch(this));
            return result;
        };

        const onSerialize = nodeType.prototype.onSerialize;
        nodeType.prototype.onSerialize = function (...args) {
            // Temporarily un-hide everything so the workflow saves the full
            // widget/input set, then re-apply visibility.
            restoreAllForSerialization(this);
            try {
                return onSerialize?.apply(this, args);
            } finally {
                refreshRows(this);
            }
        };
    },
    nodeCreated(node) {
        if (isTargetNode(node)) requestAnimationFrame(() => patch(node));
    },
});
