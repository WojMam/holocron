"use strict";

(function bootstrap() {
  const SELECTORS = {
    statusBadge: document.getElementById("status-badge"),
    searchInput: document.getElementById("search-input"),
    searchLabel: document.getElementById("search-label"),
    kindFilterWrap: document.getElementById("kind-filter-wrap"),
    kindFilter: document.getElementById("kind-filter"),
    catalogTitle: document.getElementById("catalog-title"),
    catalogList: document.getElementById("catalog-list"),
    selectedTitle: document.getElementById("selected-title"),
    selectedCardPanel: document.getElementById("selected-card-panel"),
    inspectorTitle: document.getElementById("inspector-title"),
    inspectorPanel: document.getElementById("inspector-panel"),
    breadcrumbs: document.getElementById("breadcrumbs"),
    fieldUsageBanner: document.getElementById("field-usage-banner"),
    viewModeButtons: Array.from(document.querySelectorAll(".view-mode-btn")),
  };

  const state = {
    dataset: emptyDataset(),
    index: null,
    activeView: "cards",
    selectedCardId: null,
    selectedFieldId: null,
    selectedFlowId: null,
    selectedElement: null,
    highlightedTargets: new Set(),
    searchQuery: "",
    kindFilter: "all",
    errors: [],
  };

  start().catch((error) => {
    state.errors.push(`Błąd startu: ${safeString(error)}`);
    render();
  });

  async function start() {
    setStatus("Ładowanie danych...");
    const { dataset, errors } = await loadDataset("./data/manifest.yaml");
    state.dataset = dataset;
    state.errors = errors;
    state.selectedCardId = dataset.nodes[0] ? dataset.nodes[0].id : null;
    state.selectedFieldId = dataset.fields[0] ? dataset.fields[0].id : null;
    state.selectedFlowId = dataset.flows[0] ? dataset.flows[0].id : null;
    state.index = buildSearchIndex(dataset);
    bindEvents();
    render();
    setStatus("Gotowe");
  }

  function bindEvents() {
    SELECTORS.searchInput.addEventListener("input", () => {
      state.searchQuery = SELECTORS.searchInput.value.trim();
      render();
    });

    SELECTORS.kindFilter.addEventListener("change", () => {
      state.kindFilter = SELECTORS.kindFilter.value;
      render();
    });

    SELECTORS.viewModeButtons.forEach((button) => {
      button.addEventListener("click", () => {
        const mode = button.getAttribute("data-view-mode");
        if (!mode) {
          return;
        }
        state.activeView = mode;
        state.searchQuery = "";
        SELECTORS.searchInput.value = "";
        state.selectedElement = null;
        state.highlightedTargets.clear();
        SELECTORS.fieldUsageBanner.classList.add("hidden");
        render();
      });
    });
  }

  async function loadDataset(manifestPath) {
    const errors = [];
    const manifest = await loadYaml(manifestPath, errors);
    if (!manifest) {
      return { dataset: emptyDataset(), errors };
    }

    const [nodes, fields, flows] = await Promise.all([
      loadYamlGroup(manifest.nodes, "./data/", errors),
      loadYamlGroup(manifest.fields, "./data/", errors),
      loadYamlGroup(manifest.flows, "./data/", errors),
    ]);

    return {
      dataset: normalizeDataset(nodes, fields, flows, errors),
      errors,
    };
  }

  async function loadYamlGroup(paths, basePath, errors) {
    if (!Array.isArray(paths)) {
      errors.push("Manifest: oczekiwano listy plików.");
      return [];
    }
    const files = await Promise.all(paths.map((path) => loadYaml(basePath + path, errors)));
    return files.filter(Boolean);
  }

  async function loadYaml(path, errors) {
    try {
      const response = await fetch(path);
      if (!response.ok) {
        errors.push(`Nie udało się pobrać pliku: ${path} (${response.status})`);
        return null;
      }
      const text = await response.text();
      return window.jsyaml.load(text);
    } catch (error) {
      errors.push(`Błąd YAML ${path}: ${safeString(error)}`);
      return null;
    }
  }

  function normalizeDataset(nodesRaw, fieldsRaw, flowsRaw, errors) {
    const nodesById = toMapById(nodesRaw, "Node", errors);
    const fieldsById = toMapById(fieldsRaw, "FieldConcept", errors);
    const flowsById = toMapById(flowsRaw, "Flow", errors);

    const nodes = [...nodesById.values()].map((node) => ({
      ...node,
      elements: Array.isArray(node.elements) ? node.elements : [],
    }));
    const fields = [...fieldsById.values()];
    const flows = [...flowsById.values()].map((flow) => ({
      ...flow,
      steps: Array.isArray(flow.steps) ? flow.steps : [],
    }));

    const maps = {
      nodesById: toPlainMap(nodesById),
      fieldsById: toPlainMap(fieldsById),
      flowsById: toPlainMap(flowsById),
    };

    return {
      nodes,
      fields,
      flows,
      maps,
      indexes: {
        usageByField: indexFieldUsages(nodes, fields),
      },
    };
  }

  function indexFieldUsages(nodes, fields) {
    const knownFields = new Set(fields.map((field) => field.id));
    const out = {};
    for (const node of nodes) {
      for (const element of node.elements) {
        const fieldId = element.semanticRef;
        if (!fieldId || !knownFields.has(fieldId)) {
          continue;
        }
        out[fieldId] ||= [];
        out[fieldId].push({
          nodeId: node.id,
          nodeLabel: node.label || node.id,
          elementLabel: element.label || element.id,
          direction: element.direction || "unknown",
          usageType: inferUsageType(node, element),
        });
      }
    }
    return out;
  }

  function inferUsageType(node, element) {
    if (node.technology === "db" && element.direction === "output") {
      return "stored_in";
    }
    if (node.technology === "mq" && element.direction === "output") {
      return "published_to";
    }
    if (element.direction === "input") {
      return "consumed_by";
    }
    return "derived_in";
  }

  function toMapById(items, entityName, errors) {
    const map = new Map();
    if (!Array.isArray(items)) {
      errors.push(`${entityName}: spodziewano się listy.`);
      return map;
    }
    for (const item of items) {
      if (!item || !item.id) {
        errors.push(`${entityName}: obiekt bez id.`);
        continue;
      }
      if (map.has(item.id)) {
        errors.push(`${entityName}: duplikat id '${item.id}'.`);
        continue;
      }
      map.set(item.id, item);
    }
    return map;
  }

  function toPlainMap(map) {
    const out = {};
    for (const [key, value] of map.entries()) {
      out[key] = value;
    }
    return out;
  }

  function emptyDataset() {
    return {
      nodes: [],
      fields: [],
      flows: [],
      maps: { nodesById: {}, fieldsById: {}, flowsById: {} },
      indexes: { usageByField: {} },
    };
  }

  function buildSearchIndex(dataset) {
    const docs = [];
    dataset.nodes.forEach((node) => {
      docs.push({
        id: `node:${node.id}`,
        entityType: "node",
        entityId: node.id,
        label: node.label || node.id,
        body: `${node.description || ""} ${node.technology || ""} ${node.uri || ""} ${node.table || ""}`,
      });
    });
    dataset.fields.forEach((field) => {
      docs.push({
        id: `field:${field.id}`,
        entityType: "field",
        entityId: field.id,
        label: field.label || field.id,
        body: `${field.description || ""} ${asStringList(field.examples).join(" ")}`,
      });
    });
    dataset.flows.forEach((flow) => {
      docs.push({
        id: `flow:${flow.id}`,
        entityType: "flow",
        entityId: flow.id,
        label: flow.label || flow.id,
        body: `${flow.description || ""} ${flow.steps.map((s) => s.node).join(" ")}`,
      });
    });

    const docsById = {};
    docs.forEach((doc) => {
      docsById[doc.id] = doc;
    });

    if (!docs.length) {
      return { index: null, docsById };
    }

    const index = lunr(function defineIndex() {
      this.ref("id");
      this.field("label");
      this.field("body");
      docs.forEach((doc) => this.add(doc));
    });
    return { index, docsById };
  }

  function search(query, entityType) {
    if (!query || !state.index || !state.index.index) {
      return null;
    }
    try {
      const docs = state.index.index.search(`${query}*`).map((hit) => state.index.docsById[hit.ref]).filter(Boolean);
      return entityType ? docs.filter((doc) => doc.entityType === entityType) : docs;
    } catch (_error) {
      return null;
    }
  }

  function render() {
    renderViewModeButtons();
    renderCatalog();
    renderCenterContent();
    renderBreadcrumbs();
  }

  function renderViewModeButtons() {
    SELECTORS.viewModeButtons.forEach((button) => {
      button.classList.toggle("active", button.getAttribute("data-view-mode") === state.activeView);
    });
  }

  function renderCatalog() {
    const config = {
      cards: { title: "Katalog kart", label: "Szukaj kart", placeholder: "API, DB, MQ, XML...", showKind: true },
      fields: { title: "Katalog pól", label: "Szukaj pól", placeholder: "Field, format, opis...", showKind: false },
      flows: { title: "Katalog flow", label: "Szukaj flow", placeholder: "Flow, krok, node...", showKind: false },
    }[state.activeView];

    SELECTORS.catalogTitle.textContent = config.title;
    SELECTORS.searchLabel.textContent = config.label;
    SELECTORS.searchInput.placeholder = config.placeholder;
    SELECTORS.kindFilterWrap.classList.toggle("hidden", !config.showKind);

    SELECTORS.catalogList.innerHTML = "";
    if (state.activeView === "cards") {
      filteredNodes().forEach((node) => {
        SELECTORS.catalogList.appendChild(catalogButton(node.id, node.label || node.id, node.technology || node.kind || "unknown", () => {
          state.selectedCardId = node.id;
          state.selectedElement = null;
          state.highlightedTargets.clear();
          SELECTORS.fieldUsageBanner.classList.add("hidden");
          render();
        }, state.selectedCardId === node.id));
      });
      return;
    }

    if (state.activeView === "fields") {
      filteredFields().forEach((field) => {
        SELECTORS.catalogList.appendChild(catalogButton(field.id, field.label || field.id, field.format || "field", () => {
          state.selectedFieldId = field.id;
          renderCenterContent();
          renderBreadcrumbs();
        }, state.selectedFieldId === field.id));
      });
      return;
    }

    filteredFlows().forEach((flow) => {
      SELECTORS.catalogList.appendChild(catalogButton(flow.id, flow.label || flow.id, `${flow.steps.length} kroków`, () => {
        state.selectedFlowId = flow.id;
        renderCenterContent();
        renderBreadcrumbs();
      }, state.selectedFlowId === flow.id));
    });
  }

  function catalogButton(id, title, subtitle, onClick, isActive) {
    const li = document.createElement("li");
    const button = document.createElement("button");
    button.className = `entity-button${isActive ? " active" : ""}`;
    button.type = "button";
    button.dataset.id = id;
    button.innerHTML = `${escapeHtml(title)}<small>${escapeHtml(subtitle)}</small>`;
    button.addEventListener("click", onClick);
    li.appendChild(button);
    return li;
  }

  function renderCenterContent() {
    SELECTORS.selectedCardPanel.innerHTML = "";
    SELECTORS.inspectorPanel.innerHTML = "";
    if (state.activeView === "cards") {
      SELECTORS.selectedTitle.textContent = "Wybrana karta";
      SELECTORS.inspectorTitle.textContent = "Szczegóły zaznaczenia";
      renderSelectedCard();
      renderCardInspector();
      return;
    }
    SELECTORS.fieldUsageBanner.classList.add("hidden");
    if (state.activeView === "fields") {
      SELECTORS.selectedTitle.textContent = "Wybrane pole";
      SELECTORS.inspectorTitle.textContent = "Użycia pola";
      renderSelectedField();
      renderFieldInspector();
      return;
    }
    SELECTORS.selectedTitle.textContent = "Wybrany flow";
    SELECTORS.inspectorTitle.textContent = "Kroki i przejścia";
    renderSelectedFlow();
    renderFlowInspector();
  }

  function filteredNodes() {
    const filteredByKind = state.dataset.nodes.filter((node) =>
      state.kindFilter === "all" ? true : node.technology === state.kindFilter,
    );
    if (!state.searchQuery) {
      return filteredByKind;
    }
    const hits = search(state.searchQuery, "node");
    if (!hits) {
      return filteredByKind.filter((node) => simpleContains(node, state.searchQuery));
    }
    const hitIds = new Set(hits.map((h) => h.entityId));
    return filteredByKind.filter((node) => hitIds.has(node.id) || simpleContains(node, state.searchQuery));
  }

  function filteredFields() {
    if (!state.searchQuery) {
      return state.dataset.fields;
    }
    const hits = search(state.searchQuery, "field");
    if (!hits) {
      return state.dataset.fields.filter((field) => simpleContains(field, state.searchQuery));
    }
    const hitIds = new Set(hits.map((h) => h.entityId));
    return state.dataset.fields.filter((field) => hitIds.has(field.id) || simpleContains(field, state.searchQuery));
  }

  function filteredFlows() {
    if (!state.searchQuery) {
      return state.dataset.flows;
    }
    const hits = search(state.searchQuery, "flow");
    if (!hits) {
      return state.dataset.flows.filter((flow) => simpleContains(flow, state.searchQuery));
    }
    const hitIds = new Set(hits.map((h) => h.entityId));
    return state.dataset.flows.filter((flow) => hitIds.has(flow.id) || simpleContains(flow, state.searchQuery));
  }

  function simpleContains(item, query) {
    const hay = JSON.stringify(item).toLowerCase();
    return hay.includes(query.toLowerCase());
  }

  function renderSelectedCard() {
    const node = state.dataset.maps.nodesById[state.selectedCardId];
    if (!node) {
      SELECTORS.selectedCardPanel.innerHTML = "<p class='muted'>Wybierz kartę z katalogu.</p>";
      return;
    }
    const card = document.createElement("article");
    card.className = `card-item ${state.highlightedTargets.has(node.id) ? "highlighted" : ""}`;
    card.innerHTML = cardHtml(node);
    card.addEventListener("click", (event) => {
      const target = event.target;
      if (!(target instanceof HTMLElement)) {
        return;
      }
      if (target.dataset.fieldRef) {
        selectElement(node.id, target.dataset.fieldRef, target.dataset.fieldDirection || "output");
      }
    });
    SELECTORS.selectedCardPanel.appendChild(card);
  }

  function cardHtml(node) {
    const inputFields = node.elements.filter((e) => e.direction === "input");
    const outputFields = node.elements.filter((e) => e.direction === "output");
    return `
      <div class="card-head">
        <div>
          <div class="card-title">${escapeHtml(node.label || node.id)}</div>
          <div class="meta">${escapeHtml(node.technology || node.kind || "unknown")} · ${escapeHtml(node.id)}</div>
        </div>
        <span class="tag">${escapeHtml(node.kind || "node")}</span>
      </div>
      <p class="note">${escapeHtml(node.description || "Brak opisu.")}</p>
      ${node.uri ? `<p class="meta"><strong>URI:</strong> ${escapeHtml(node.uri)}</p>` : ""}
      ${node.table ? `<p class="meta"><strong>Tabela:</strong> ${escapeHtml(node.table)}</p>` : ""}
      ${node.documentType ? `<p class="meta"><strong>Dokument:</strong> ${escapeHtml(node.documentType)}</p>` : ""}
      ${node.developerNotes ? `<p class="meta"><strong>Notatki:</strong> ${escapeHtml(node.developerNotes)}</p>` : ""}
      ${implementationFilesHtml(node.implementationFiles)}
      <section class="field-group">
        <h4>Input</h4>
        <div class="field-list">${fieldPills(node.id, inputFields, "input")}</div>
      </section>
      <section class="field-group">
        <h4>Output</h4>
        <div class="field-list">${fieldPills(node.id, outputFields, "output")}</div>
      </section>
    `;
  }

  function implementationFilesHtml(files) {
    if (!Array.isArray(files) || !files.length) {
      return "";
    }
    const rows = files
      .map((entry) => {
        const role = entry.label || entry.role || "Implementation";
        const path = entry.path || "";
        const details = entry.details || "";
        return `<li class="impl-row"><span class="impl-role">${escapeHtml(role)}</span><code class="impl-path">${escapeHtml(
          path,
        )}</code>${details ? `<small class="meta">${escapeHtml(details)}</small>` : ""}</li>`;
      })
      .join("");
    return `<section class="field-group"><h4>Implementacja w kodzie</h4><ul class="impl-list">${rows}</ul></section>`;
  }

  function fieldPills(nodeId, elements, direction) {
    if (!elements.length) {
      return "<span class='meta'>brak</span>";
    }
    return elements
      .map((element) => {
        const semanticRef = element.semanticRef || "";
        const isRegisteredField = Boolean(semanticRef && state.dataset.maps.fieldsById[semanticRef]);
        const active =
          isRegisteredField && state.selectedElement && state.selectedElement.nodeId === nodeId && state.selectedElement.fieldId === semanticRef;

        if (!isRegisteredField) {
          return `<span class="field-pill inactive" title="Pole nie jest zdefiniowane w katalogu fields">${escapeHtml(
            element.label || element.id,
          )}</span>`;
        }

        return `<button type="button" class="field-pill ${active ? "active" : ""}" data-field-ref="${escapeHtml(
          semanticRef,
        )}" data-field-direction="${direction}">${escapeHtml(element.label || element.id)}</button>`;
      })
      .join("");
  }

  function selectElement(nodeId, fieldId, direction) {
    if (!fieldId) {
      return;
    }
    state.selectedCardId = nodeId;
    state.selectedElement = { nodeId, fieldId, direction };
    const usages = (state.dataset.indexes.usageByField[fieldId] || []).filter((usage) => usage.nodeId !== nodeId);
    state.highlightedTargets = new Set(usages.map((usage) => usage.nodeId));
    const field = state.dataset.maps.fieldsById[fieldId];
    SELECTORS.fieldUsageBanner.classList.remove("hidden");
    SELECTORS.fieldUsageBanner.textContent = `${field ? field.label : fieldId}: znaleziono ${usages.length} dalszych użyć.`;
    render();
  }

  function jumpToRelatedCard(nodeId) {
    state.selectedCardId = nodeId;
    state.selectedElement = null;
    state.highlightedTargets = new Set([nodeId]);
    render();
  }

  function renderCardInspector() {
    if (!state.selectedElement) {
      SELECTORS.inspectorPanel.innerHTML = "<p class='meta'>Kliknij pole na wybranej karcie, aby zobaczyć jego opis i użycia.</p>";
      return;
    }
    const { nodeId, fieldId } = state.selectedElement;
    const field = state.dataset.maps.fieldsById[fieldId];
    const usages = (state.dataset.indexes.usageByField[fieldId] || []).filter((usage) => usage.nodeId !== nodeId);
    SELECTORS.inspectorPanel.innerHTML = `
      <div class="inline-usage">
        <h5>${escapeHtml(field ? field.label : fieldId)} · szczegóły pola</h5>
        <p class="meta">${escapeHtml(field ? field.description || "" : "")}</p>
        <p class="meta"><strong>Format:</strong> ${escapeHtml(field ? field.format || "n/a" : "n/a")}</p>
        <p class="meta"><strong>Dalsze użycia:</strong> ${usages.length}</p>
        ${
          usages.length
            ? usages
                .map(
                  (usage) =>
                    `<button type="button" class="entity-button usage-link" data-inspector-jump="${escapeHtml(
                      usage.nodeId,
                    )}">${escapeHtml(usage.nodeLabel)}<small>${escapeHtml(usage.usageType)} · ${escapeHtml(
                      usage.elementLabel,
                    )}</small></button>`,
                )
                .join("")
            : "<p class='meta'>Brak dalszych użyć.</p>"
        }
      </div>
    `;
    const buttons = SELECTORS.inspectorPanel.querySelectorAll("[data-inspector-jump]");
    buttons.forEach((button) => {
      button.addEventListener("click", () => {
        const nodeIdToJump = button.getAttribute("data-inspector-jump");
        if (nodeIdToJump) {
          jumpToRelatedCard(nodeIdToJump);
        }
      });
    });
  }

  function renderSelectedField() {
    const field = state.dataset.maps.fieldsById[state.selectedFieldId];
    if (!field) {
      SELECTORS.selectedCardPanel.innerHTML = "<p class='muted'>Wybierz pole z katalogu.</p>";
      return;
    }
    SELECTORS.selectedCardPanel.innerHTML = `
      <article class="card-item">
        <div class="card-head">
          <div>
            <div class="card-title">${escapeHtml(field.label || field.id)}</div>
            <div class="meta">${escapeHtml(field.id)}</div>
          </div>
          <span class="tag">${escapeHtml(field.format || "field")}</span>
        </div>
        <p class="note">${escapeHtml(field.description || "Brak opisu.")}</p>
      </article>
    `;
  }

  function renderFieldInspector() {
    const field = state.dataset.maps.fieldsById[state.selectedFieldId];
    if (!field) {
      SELECTORS.inspectorPanel.innerHTML = "<p class='meta'>Brak danych pola.</p>";
      return;
    }
    const usages = state.dataset.indexes.usageByField[field.id] || [];
    SELECTORS.inspectorPanel.innerHTML = `
      <div class="inline-usage">
        <h5>Użycia pola: ${escapeHtml(field.label || field.id)}</h5>
        <p class="meta">Liczba użyć: ${usages.length}</p>
        ${
          usages.length
            ? usages
                .map(
                  (usage) =>
                    `<button type="button" class="entity-button usage-link" data-inspector-jump="${escapeHtml(
                      usage.nodeId,
                    )}">${escapeHtml(usage.nodeLabel)}<small>${escapeHtml(usage.usageType)}</small></button>`,
                )
                .join("")
            : "<p class='meta'>Brak użyć.</p>"
        }
      </div>
    `;
    const buttons = SELECTORS.inspectorPanel.querySelectorAll("[data-inspector-jump]");
    buttons.forEach((button) => {
      button.addEventListener("click", () => {
        const nodeIdToJump = button.getAttribute("data-inspector-jump");
        if (nodeIdToJump) {
          state.activeView = "cards";
          state.selectedCardId = nodeIdToJump;
          state.selectedElement = null;
          render();
        }
      });
    });
  }

  function renderSelectedFlow() {
    const flow = state.dataset.maps.flowsById[state.selectedFlowId];
    if (!flow) {
      SELECTORS.selectedCardPanel.innerHTML = "<p class='muted'>Wybierz flow z katalogu.</p>";
      return;
    }
    SELECTORS.selectedCardPanel.innerHTML = `
      <article class="card-item">
        <div class="card-head">
          <div>
            <div class="card-title">${escapeHtml(flow.label || flow.id)}</div>
            <div class="meta">${escapeHtml(flow.id)}</div>
          </div>
          <span class="tag">flow</span>
        </div>
        <p class="note">${escapeHtml(flow.description || "Brak opisu.")}</p>
      </article>
    `;
  }

  function renderFlowInspector() {
    const flow = state.dataset.maps.flowsById[state.selectedFlowId];
    if (!flow) {
      SELECTORS.inspectorPanel.innerHTML = "<p class='meta'>Brak danych flow.</p>";
      return;
    }
    SELECTORS.inspectorPanel.innerHTML = `
      <div class="inline-usage">
        <h5>Kroki flow</h5>
        ${
          flow.steps.length
            ? flow.steps
                .map(
                  (step, idx) =>
                    `<button type="button" class="entity-button usage-link" data-inspector-jump="${escapeHtml(
                      step.node,
                    )}">${idx + 1}. ${escapeHtml(step.node)}</button>`,
                )
                .join("")
            : "<p class='meta'>Brak kroków.</p>"
        }
      </div>
    `;
    const buttons = SELECTORS.inspectorPanel.querySelectorAll("[data-inspector-jump]");
    buttons.forEach((button) => {
      button.addEventListener("click", () => {
        const nodeIdToJump = button.getAttribute("data-inspector-jump");
        if (nodeIdToJump) {
          state.activeView = "cards";
          state.selectedCardId = nodeIdToJump;
          state.selectedElement = null;
          render();
        }
      });
    });
  }

  function renderBreadcrumbs() {
    if (state.activeView === "cards") {
      const node = state.dataset.maps.nodesById[state.selectedCardId];
      SELECTORS.breadcrumbs.textContent = node ? `Katalog kart / ${node.technology || "node"} / ${node.id}` : "Katalog kart";
      return;
    }
    if (state.activeView === "fields") {
      const field = state.dataset.maps.fieldsById[state.selectedFieldId];
      SELECTORS.breadcrumbs.textContent = field ? `Katalog pól / ${field.id}` : "Katalog pól";
      return;
    }
    const flow = state.dataset.maps.flowsById[state.selectedFlowId];
    SELECTORS.breadcrumbs.textContent = flow ? `Katalog flow / ${flow.id}` : "Katalog flow";
  }

  function setStatus(text) {
    SELECTORS.statusBadge.textContent = text;
  }

  function asStringList(value) {
    return Array.isArray(value) ? value.filter((item) => typeof item === "string") : [];
  }

  function escapeHtml(text) {
    return String(text || "")
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;")
      .replace(/'/g, "&#039;");
  }

  function safeString(error) {
    if (!error) {
      return "nieznany błąd";
    }
    if (typeof error === "string") {
      return error;
    }
    return error.message || String(error);
  }
})();
