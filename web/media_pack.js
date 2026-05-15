import { app } from "../../scripts/app.js";

const NODE_NAME = "StringNumberListItem";
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

    if (!widget.mediaPackOriginalComputeSize) {
        widget.mediaPackOriginalComputeSize = widget.computeSize;
    }

    widget.hidden = !visible;
    widget.disabled = !visible;
    widget.computeSize = visible
        ? widget.mediaPackOriginalComputeSize
        : () => HIDDEN_WIDGET_SIZE;

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
        if (nodeData.name !== NODE_NAME) {
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
});
