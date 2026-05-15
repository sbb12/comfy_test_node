import { app } from "../../scripts/app.js";

const NODE_NAMES = new Set(["StringNumberListItem", "sx_string_number_list_item"]);
const ROW_COUNT = 20;
const HIDDEN_WIDGET_SIZE = [0, -4];

function rowStringWidget(node, rowIndex) {
    return node.widgets?.find((widget) => widget.name === `row_${rowIndex}_string`);
}

function rowWidgets(node, rowIndex) {
    return [
        rowStringWidget(node, rowIndex),
        node.widgets?.find((widget) => widget.name === `row_${rowIndex}_number`),
    ].filter(Boolean);
}

function rowHasText(node, rowIndex) {
    const widget = rowStringWidget(node, rowIndex);
    return String(widget?.value ?? "").trim().length > 0;
}

function rowShouldBeVisible(node, rowIndex) {
    if (rowIndex === 0) {
        return true;
    }

    for (let index = 0; index < rowIndex; index++) {
        if (!rowHasText(node, index)) {
            return false;
        }
    }

    return true;
}

function setElementVisible(element, visible) {
    if (!element?.style) {
        return;
    }

    element.style.display = visible ? "" : "none";
}

function setWidgetVisible(widget, visible) {
    if (!widget) {
        return;
    }

    if (!widget.mediaPackStoredOriginals) {
        widget.mediaPackOriginalComputeSize = widget.computeSize;
        widget.mediaPackOriginalDraw = widget.draw;
        widget.mediaPackStoredOriginals = true;
    }

    widget.hidden = !visible;
    widget.disabled = !visible;
    widget.computeSize = visible
        ? widget.mediaPackOriginalComputeSize
        : () => HIDDEN_WIDGET_SIZE;
    widget.draw = visible ? widget.mediaPackOriginalDraw : () => {};

    setElementVisible(widget.element, visible);
    setElementVisible(widget.inputEl, visible);
}

function refreshRows(node) {
    let changed = false;

    for (let rowIndex = 0; rowIndex < ROW_COUNT; rowIndex++) {
        const visible = rowShouldBeVisible(node, rowIndex);
        for (const widget of rowWidgets(node, rowIndex)) {
            if (widget.hidden === visible) {
                changed = true;
            }
            setWidgetVisible(widget, visible);
        }
    }

    if (changed) {
        node.setSize?.(node.computeSize());
        app.graph?.setDirtyCanvas(true, true);
    }
}

function wrapStringWidgetCallbacks(node) {
    for (let rowIndex = 0; rowIndex < ROW_COUNT; rowIndex++) {
        const widget = rowStringWidget(node, rowIndex);
        if (!widget || widget.mediaPackWrapped) {
            continue;
        }

        const originalCallback = widget.callback;
        widget.callback = function (...args) {
            const result = originalCallback?.apply(this, args);
            refreshRows(node);
            return result;
        };
        widget.mediaPackWrapped = true;
    }
}

app.registerExtension({
    name: "MediaPack.StringNumberListItem",
    beforeRegisterNodeDef(nodeType, nodeData) {
        if (
            !NODE_NAMES.has(nodeData.name) &&
            !NODE_NAMES.has(nodeData.display_name)
        ) {
            return;
        }

        const onNodeCreated = nodeType.prototype.onNodeCreated;
        nodeType.prototype.onNodeCreated = function (...args) {
            const result = onNodeCreated?.apply(this, args);
            wrapStringWidgetCallbacks(this);
            refreshRows(this);
            return result;
        };

        const onConfigure = nodeType.prototype.onConfigure;
        nodeType.prototype.onConfigure = function (...args) {
            const result = onConfigure?.apply(this, args);
            wrapStringWidgetCallbacks(this);
            refreshRows(this);
            return result;
        };
    },
    nodeCreated(node) {
        if (
            !NODE_NAMES.has(node.comfyClass) &&
            !NODE_NAMES.has(node.title) &&
            !NODE_NAMES.has(node.constructor?.comfyClass)
        ) {
            return;
        }

        wrapStringWidgetCallbacks(node);
        refreshRows(node);
    },
});
