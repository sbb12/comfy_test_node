import { app } from "../../scripts/app.js";

const NODE_NAMES = new Set(["StringNumberListItem", "sx_string_number_list_item"]);
const ROW_COUNT = 20;
const ROW_WIDGET_RE = /^row_(\d+)_(string|number)$/;
const HIDDEN_SIZE = [0, -4];

function isTargetNode(node) {
    return (
        NODE_NAMES.has(node.comfyClass) ||
        NODE_NAMES.has(node.constructor?.comfyClass) ||
        NODE_NAMES.has(node.type)
    );
}

function rowIndexFromWidget(widget) {
    const match = widget?.name?.match(ROW_WIDGET_RE);
    return match ? Number(match[1]) : null;
}

function collectRows(node) {
    const rows = Array.from({ length: ROW_COUNT }, () => ({}));
    for (const widget of node.widgets ?? []) {
        const rowIndex = rowIndexFromWidget(widget);
        if (rowIndex === null) continue;
        if (widget.name.endsWith("_string")) rows[rowIndex].string = widget;
        else if (widget.name.endsWith("_number")) rows[rowIndex].number = widget;
    }
    return rows;
}

function setWidgetHidden(widget, hidden) {
    if (!widget) return;

    if (hidden) {
        if (widget._mp_hidden) return;
        widget._mp_hidden = true;
        widget._mp_origType = widget.type;
        widget._mp_origComputeSize = widget.computeSize;
        widget.type = "hidden";
        widget.computeSize = () => HIDDEN_SIZE;
        for (const el of [widget.element, widget.inputEl, widget.domElement]) {
            if (el?.style) {
                el._mp_prevDisplay = el.style.display;
                el.style.display = "none";
            }
        }
    } else {
        if (!widget._mp_hidden) return;
        widget._mp_hidden = false;
        if (widget._mp_origType !== undefined) widget.type = widget._mp_origType;
        if (widget._mp_origComputeSize) widget.computeSize = widget._mp_origComputeSize;
        for (const el of [widget.element, widget.inputEl, widget.domElement]) {
            if (el?.style) {
                el.style.display = el._mp_prevDisplay ?? "";
            }
        }
    }
}

function visibleRowCount(rows) {
    let visible = 1;
    for (let i = 0; i < ROW_COUNT - 1; i++) {
        const value = String(rows[i]?.string?.value ?? "").trim();
        if (!value) break;
        visible = i + 2;
    }
    return Math.min(visible, ROW_COUNT);
}

function refreshRows(node) {
    if (!isTargetNode(node)) return;

    const rows = collectRows(node);
    const visible = visibleRowCount(rows);

    for (let i = 0; i < ROW_COUNT; i++) {
        const hide = i >= visible;
        setWidgetHidden(rows[i].string, hide);
        setWidgetHidden(rows[i].number, hide);
    }

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

function wireRow(node, widget) {
    if (!widget || widget._mp_wired) return;
    widget._mp_wired = true;

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

function wireAllRows(node) {
    const rows = collectRows(node);
    for (const row of rows) wireRow(node, row.string);
}

function patch(node) {
    if (!isTargetNode(node)) return;
    wireAllRows(node);
    refreshRows(node);
    // Some DOM widgets attach their input element asynchronously.
    setTimeout(() => {
        wireAllRows(node);
        refreshRows(node);
    }, 100);
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
    },
    nodeCreated(node) {
        if (isTargetNode(node)) requestAnimationFrame(() => patch(node));
    },
});
