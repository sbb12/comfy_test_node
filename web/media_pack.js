import { app } from "../../scripts/app.js";

const NODE_NAMES = new Set(["StringNumberListItem", "sx_string_number_list_item"]);
const ROW_COUNT = 20;
const ROW_WIDGET_RE = /^row_(\d+)_(string|number)$/;

function isTargetNode(node) {
    return (
        NODE_NAMES.has(node.comfyClass) ||
        NODE_NAMES.has(node.title) ||
        NODE_NAMES.has(node.constructor?.comfyClass)
    );
}

function rowIndexFromWidget(widget) {
    const match = widget?.name?.match(ROW_WIDGET_RE);
    return match ? Number(match[1]) : null;
}

function buildWidgetCache(node) {
    if (node.mediaPackWidgetCacheReady) {
        return;
    }

    node.mediaPackBaseWidgets = [];
    node.mediaPackRows = Array.from({ length: ROW_COUNT }, () => []);

    for (const widget of node.widgets ?? []) {
        const rowIndex = rowIndexFromWidget(widget);
        if (rowIndex === null) {
            node.mediaPackBaseWidgets.push(widget);
            continue;
        }

        node.mediaPackRows[rowIndex]?.push(widget);
    }

    for (const row of node.mediaPackRows) {
        row.sort((left, right) => {
            const leftIsString = left.name.endsWith("_string") ? 0 : 1;
            const rightIsString = right.name.endsWith("_string") ? 0 : 1;
            return leftIsString - rightIsString;
        });
    }

    node.mediaPackWidgetCacheReady = true;
}

function rowStringWidget(node, rowIndex) {
    buildWidgetCache(node);
    return node.mediaPackRows[rowIndex]?.find((widget) =>
        widget.name.endsWith("_string")
    );
}

function rowHasText(node, rowIndex) {
    const widget = rowStringWidget(node, rowIndex);
    return String(widget?.value ?? "").trim().length > 0;
}

function visibleRowCount(node) {
    let count = 1;

    for (let rowIndex = 0; rowIndex < ROW_COUNT - 1; rowIndex++) {
        if (!rowHasText(node, rowIndex)) {
            break;
        }
        count = rowIndex + 2;
    }

    return Math.min(count, ROW_COUNT);
}

function refreshRows(node) {
    if (!isTargetNode(node)) {
        return;
    }

    buildWidgetCache(node);

    const nextWidgets = [...node.mediaPackBaseWidgets];
    const rowsToShow = visibleRowCount(node);

    for (let rowIndex = 0; rowIndex < rowsToShow; rowIndex++) {
        nextWidgets.push(...node.mediaPackRows[rowIndex]);
    }

    const changed =
        nextWidgets.length !== node.widgets.length ||
        nextWidgets.some((widget, index) => widget !== node.widgets[index]);

    if (!changed) {
        return;
    }

    node.widgets = nextWidgets;
    node.setSize?.(node.computeSize());
    app.graph?.setDirtyCanvas(true, true);
}

function wrapStringWidgetCallbacks(node) {
    buildWidgetCache(node);

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

function patchNode(node) {
    if (!isTargetNode(node)) {
        return;
    }

    buildWidgetCache(node);
    wrapStringWidgetCallbacks(node);
    refreshRows(node);
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
            patchNode(this);
            return result;
        };

        const onConfigure = nodeType.prototype.onConfigure;
        nodeType.prototype.onConfigure = function (...args) {
            const result = onConfigure?.apply(this, args);
            this.mediaPackWidgetCacheReady = false;
            patchNode(this);
            return result;
        };

        const onSerialize = nodeType.prototype.onSerialize;
        nodeType.prototype.onSerialize = function (...args) {
            const originalWidgets = this.widgets;
            buildWidgetCache(this);
            this.widgets = [
                ...this.mediaPackBaseWidgets,
                ...this.mediaPackRows.flat(),
            ];
            const result = onSerialize?.apply(this, args);
            this.widgets = originalWidgets;
            return result;
        };
    },
    nodeCreated(node) {
        patchNode(node);
    },
});
