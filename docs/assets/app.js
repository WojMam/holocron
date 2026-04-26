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
    planner: createPlannerState(),
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
    state.planner = createPlannerState();
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
        state.planner.previewNodeId = null;
        if (mode === "planner") {
          setStatus("Tryb planner: użyj + aby budować flow.");
        }
        render();
      });
    });

    document.addEventListener("keydown", (event) => {
      if (event.key === "Escape" && state.planner.previewNodeId) {
        state.planner.previewNodeId = null;
        render();
      }
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
        plannerNodeIO: indexPlannerNodeIO(nodes),
      },
    };
  }

  function indexPlannerNodeIO(nodes) {
    const out = {};
    for (const node of nodes) {
      const inputs = new Set();
      const outputs = new Set();
      for (const element of node.elements) {
        const ref = element.semanticRef;
        if (!ref) {
          continue;
        }
        if (element.direction === "input") {
          inputs.add(ref);
        } else if (element.direction === "output") {
          outputs.add(ref);
        }
      }
      out[node.id] = { inputs, outputs };
    }
    return out;
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
    renderPlannerNodePreviewModal();
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
      planner: { title: "Node'y planera", label: "Szukaj node'ów", placeholder: "Node, API, DB, MQ...", showKind: false },
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
    if (state.activeView !== "planner") {
      return;
    }

    SELECTORS.catalogList.innerHTML = "";
    filteredNodes().forEach((node) => {
      SELECTORS.catalogList.appendChild(catalogButton(node.id, node.label || node.id, node.technology || "node", () => {
        state.planner.previewNodeId = node.id;
        renderPlannerNodePreviewModal();
      }, state.planner.previewNodeId === node.id));
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
    if (state.activeView === "planner") {
      SELECTORS.selectedTitle.textContent = "Flow Planner";
      SELECTORS.inspectorTitle.textContent = "YAML preview";
      SELECTORS.fieldUsageBanner.classList.add("hidden");
      renderPlannerCanvas();
      renderPlannerInspector();
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

  function createPlannerState() {
    return {
      graphNodes: {},
      edges: [],
      nextGraphNodeNumber: 1,
      pendingAttach: null,
      previewNodeId: null,
      mainPathRootGraphNodeId: null,
      flowMeta: {
        id: "planner-generated-flow",
        label: "Planner Generated Flow",
        description: "Flow wygenerowany z Flow Planner.",
      },
    };
  }

  function plannerGraphNodeById(graphNodeId) {
    return state.planner.graphNodes[graphNodeId] || null;
  }

  function plannerGraphNodeEntries() {
    return Object.values(state.planner.graphNodes);
  }

  function addPlannerNode(targetGraphNodeId, side, dataNodeId) {
    const graphNodeId = `p${state.planner.nextGraphNodeNumber++}`;
    state.planner.graphNodes[graphNodeId] = {
      graphNodeId,
      dataNodeId,
      createdAt: Date.now(),
    };

    if (targetGraphNodeId) {
      const target = plannerGraphNodeById(targetGraphNodeId);
      if (target) {
        const mainPath = plannerMainPathGraphNodeIds();
        const targetMainPathIndex = mainPath.indexOf(targetGraphNodeId);
        const isMainPathTarget = targetMainPathIndex !== -1;
        const isStartInsert = side === "before" && targetMainPathIndex === 0;
        const isEndInsert = side === "after" && targetMainPathIndex === mainPath.length - 1;
        if (isMainPathTarget && !isStartInsert && !isEndInsert) {
          setStatus("Dodawanie działa tylko na początku lub końcu głównej ścieżki.");
          delete state.planner.graphNodes[graphNodeId];
          state.planner.nextGraphNodeNumber -= 1;
          return;
        }
        const bridge = plannerMainPathBridgeForTarget(targetGraphNodeId, side);
        if (side === "after") {
          const newIncoming = {
            fromGraphNodeId: target.graphNodeId,
            toGraphNodeId: graphNodeId,
            sharedFields: sharedOutputToInputFields(target.dataNodeId, dataNodeId),
          };
          const newOutgoing =
            bridge && bridge.nextGraphNodeId
              ? {
                  fromGraphNodeId: graphNodeId,
                  toGraphNodeId: bridge.nextGraphNodeId,
                  sharedFields: sharedOutputToInputFields(
                    dataNodeId,
                    plannerGraphNodeById(bridge.nextGraphNodeId)?.dataNodeId,
                  ),
                }
              : null;

          if (bridge) {
            state.planner.edges = state.planner.edges.filter(
              (edge) =>
                !(
                  edge.fromGraphNodeId === bridge.currentGraphNodeId &&
                  edge.toGraphNodeId === bridge.nextGraphNodeId
                ),
            );
          }
          state.planner.edges.push(newIncoming);
          if (newOutgoing) {
            state.planner.edges.push(newOutgoing);
          }
        } else {
          const newIncoming =
            bridge && bridge.previousGraphNodeId
              ? {
                  fromGraphNodeId: bridge.previousGraphNodeId,
                  toGraphNodeId: graphNodeId,
                  sharedFields: sharedOutputToInputFields(
                    plannerGraphNodeById(bridge.previousGraphNodeId)?.dataNodeId,
                    dataNodeId,
                  ),
                }
              : null;
          const newOutgoing = {
            fromGraphNodeId: graphNodeId,
            toGraphNodeId: target.graphNodeId,
            sharedFields: sharedOutputToInputFields(dataNodeId, target.dataNodeId),
          };

          if (bridge) {
            state.planner.edges = state.planner.edges.filter(
              (edge) =>
                !(
                  edge.fromGraphNodeId === bridge.previousGraphNodeId &&
                  edge.toGraphNodeId === bridge.currentGraphNodeId
                ),
            );
          }
          if (newIncoming) {
            state.planner.edges.push(newIncoming);
          }
          state.planner.edges.push(newOutgoing);

          // Inserting before the first node in main path must move the root,
          // otherwise the new node looks like a detached branch.
          if (targetMainPathIndex === 0) {
            state.planner.mainPathRootGraphNodeId = graphNodeId;
          }
        }
      }
    }

    if (!state.planner.mainPathRootGraphNodeId) {
      state.planner.mainPathRootGraphNodeId = graphNodeId;
    }
    state.planner.pendingAttach = null;
  }

  function removePlannerNode(graphNodeId) {
    delete state.planner.graphNodes[graphNodeId];
    state.planner.edges = state.planner.edges.filter(
      (edge) => edge.fromGraphNodeId !== graphNodeId && edge.toGraphNodeId !== graphNodeId,
    );
    if (state.planner.mainPathRootGraphNodeId === graphNodeId) {
      const first = plannerGraphNodeEntries()[0];
      state.planner.mainPathRootGraphNodeId = first ? first.graphNodeId : null;
    }
    if (state.planner.pendingAttach && state.planner.pendingAttach.targetGraphNodeId === graphNodeId) {
      state.planner.pendingAttach = null;
    }
  }

  function sharedOutputToInputFields(sourceDataNodeId, targetDataNodeId) {
    const source = state.dataset.indexes.plannerNodeIO[sourceDataNodeId];
    const target = state.dataset.indexes.plannerNodeIO[targetDataNodeId];
    if (!source || !target) {
      return [];
    }
    const matches = [];
    for (const ref of source.outputs) {
      if (target.inputs.has(ref)) {
        matches.push(ref);
      }
    }
    return matches;
  }

  function plannerCandidates(targetGraphNodeId, side) {
    const target = plannerGraphNodeById(targetGraphNodeId);
    if (!target) {
      return [];
    }
    const bridge = plannerMainPathBridgeForTarget(targetGraphNodeId, side);
    return filteredNodes()
      .map((node) => {
        const shared =
          side === "after"
            ? sharedOutputToInputFields(target.dataNodeId, node.id)
            : sharedOutputToInputFields(node.id, target.dataNodeId);
        const bridgeShared =
          side === "after"
            ? bridge && bridge.nextGraphNodeId
              ? sharedOutputToInputFields(node.id, plannerGraphNodeById(bridge.nextGraphNodeId)?.dataNodeId)
              : []
            : bridge && bridge.previousGraphNodeId
              ? sharedOutputToInputFields(plannerGraphNodeById(bridge.previousGraphNodeId)?.dataNodeId, node.id)
              : [];
        return { node, shared, bridgeShared };
      })
      .filter((entry) => {
        if (!entry.shared.length) {
          return false;
        }
        if (!bridge) {
          return true;
        }
        return entry.bridgeShared.length > 0;
      })
      .sort((a, b) => b.shared.length + b.bridgeShared.length - (a.shared.length + a.bridgeShared.length) || a.node.id.localeCompare(b.node.id));
  }

  function renderPlannerCanvas() {
    const nodes = plannerGraphNodeEntries();
    const pending = state.planner.pendingAttach;
    if (!nodes.length) {
      const starterCandidates = filteredNodes()
        .map((node) => {
          const io = state.dataset.indexes.plannerNodeIO[node.id];
          const score = (io ? io.inputs.size : 0) + (io ? io.outputs.size : 0);
          return { node, score };
        })
        .sort((a, b) => b.score - a.score || a.node.id.localeCompare(b.node.id))
        .slice(0, 12);
      SELECTORS.selectedCardPanel.innerHTML = `
        <div class="planner-empty">
          <p class="note">Dodaj pierwszy node, aby zacząć budować flow.</p>
          <button type="button" class="entity-button" data-planner-add-first="1">+ Dodaj pierwszy node</button>
          ${
            pending && pending.targetGraphNodeId === null
              ? `<div class="planner-candidates">
              ${starterCandidates
                .map(
                  ({ node }) => `
                    <button type="button" class="entity-button usage-link" data-planner-candidate="${escapeHtml(
                      node.id,
                    )}" data-planner-target="" data-planner-side="after">
                      ${escapeHtml(node.label || node.id)}
                      <small>${escapeHtml(node.technology || "node")}</small>
                    </button>
                  `,
                )
                .join("")}
            </div>`
              : ""
          }
        </div>
      `;
      bindPlannerCanvasEvents();
      return;
    }

    const mainPath = plannerMainPathGraphNodeIds();
    const mainSet = new Set(mainPath);
    const laneParts = [];
    if (mainPath.length) {
      const firstId = mainPath[0];
      const lastId = mainPath[mainPath.length - 1];
      const startActive = pending && pending.targetGraphNodeId === firstId && pending.side === "before";
      const endActive = pending && pending.targetGraphNodeId === lastId && pending.side === "after";
      laneParts.push(`
        <button type="button" class="planner-slot ${startActive ? "active" : ""}" data-planner-slot-target="${escapeHtml(firstId)}" data-planner-slot-side="before" aria-label="Dodaj node przed pierwszym">+</button>
      `);

      mainPath.forEach((graphNodeId) => {
        const graphNode = plannerGraphNodeById(graphNodeId);
        if (!graphNode) {
          return;
        }
        const dataNode = state.dataset.maps.nodesById[graphNode.dataNodeId];
        const isRoot = state.planner.mainPathRootGraphNodeId === graphNode.graphNodeId;
        const topBranches = plannerBranchMiniItems(graphNode.graphNodeId, "top", mainSet);
        const bottomBranches = plannerBranchMiniItems(graphNode.graphNodeId, "bottom", mainSet);

        laneParts.push(`
          <article class="planner-mini-card ${isRoot ? "root" : ""}">
            <div class="planner-branch-row top">${topBranches}</div>
            <div class="planner-mini-title">${escapeHtml(dataNode ? dataNode.label || dataNode.id : graphNode.dataNodeId)}</div>
            <div class="planner-mini-meta">${escapeHtml(graphNode.dataNodeId)}</div>
            <div class="planner-mini-actions">
              <button type="button" data-planner-set-root="${escapeHtml(graphNode.graphNodeId)}">${isRoot ? "Root" : "Ustaw root"}</button>
              <button type="button" data-planner-remove="${escapeHtml(graphNode.graphNodeId)}">Usuń</button>
            </div>
            <div class="planner-branch-row bottom">${bottomBranches}</div>
          </article>
        `);
      });

      laneParts.push(`
        <button type="button" class="planner-slot ${endActive ? "active" : ""}" data-planner-slot-target="${escapeHtml(lastId)}" data-planner-slot-side="after" aria-label="Dodaj node po ostatnim">+</button>
      `);
    }

    SELECTORS.selectedCardPanel.innerHTML = `
      <div class="planner-topbar">
        <button type="button" class="entity-button" data-planner-clear="1">Wyczyść planszę</button>
      </div>
      <div class="planner-lane-wrap">
        <div class="planner-lane">${laneParts.join("")}</div>
      </div>
      ${
        pending && pending.targetGraphNodeId
          ? `<div class="planner-candidates planner-candidates-floating">
              <h5>Kompatybilne node'y (${pending.side === "before" ? "przed" : "po"})</h5>
              ${plannerCandidatesHtml(pending.targetGraphNodeId, pending.side)}
            </div>`
          : ""
      }
    `;

    bindPlannerCanvasEvents();
  }

  function plannerCandidatesHtml(targetGraphNodeId, side) {
    const candidates = plannerCandidates(targetGraphNodeId, side);
    if (!candidates.length) {
      return `<p class="meta">Brak kompatybilnych node'ów dla kierunku: ${side === "after" ? "po" : "przed"}.</p>`;
    }
    return candidates
      .map(
        ({ node, shared }) => `
          <button type="button" class="entity-button usage-link" data-planner-candidate="${escapeHtml(node.id)}" data-planner-target="${escapeHtml(
            targetGraphNodeId,
          )}" data-planner-side="${escapeHtml(side)}">
            ${escapeHtml(node.label || node.id)}
            <small>Wspólne pola: ${escapeHtml(shared.slice(0, 3).join(", "))}${shared.length > 3 ? "..." : ""}</small>
          </button>
        `,
      )
      .join("");
  }

  function plannerMainPathBridgeForTarget(targetGraphNodeId, side) {
    const path = plannerMainPathGraphNodeIds();
    const idx = path.indexOf(targetGraphNodeId);
    if (idx === -1) {
      return null;
    }
    if (side === "before" && idx > 0) {
      return {
        previousGraphNodeId: path[idx - 1],
        currentGraphNodeId: path[idx],
      };
    }
    if (side === "after" && idx < path.length - 1) {
      return {
        currentGraphNodeId: path[idx],
        nextGraphNodeId: path[idx + 1],
      };
    }
    return null;
  }

  function renderPlannerNodePreviewModal() {
    const existing = document.getElementById("planner-node-preview-overlay");
    if (existing) {
      existing.remove();
    }
    if (state.activeView !== "planner" || !state.planner.previewNodeId) {
      return;
    }
    const node = state.dataset.maps.nodesById[state.planner.previewNodeId];
    if (!node) {
      state.planner.previewNodeId = null;
      return;
    }
    const inputCount = node.elements.filter((element) => element.direction === "input" && element.semanticRef).length;
    const outputCount = node.elements.filter((element) => element.direction === "output" && element.semanticRef).length;
    const inputElements = node.elements.filter((element) => element.direction === "input");
    const outputElements = node.elements.filter((element) => element.direction === "output");

    const overlay = document.createElement("div");
    overlay.id = "planner-node-preview-overlay";
    overlay.className = "planner-node-modal-overlay";
    overlay.innerHTML = `
      <div class="planner-node-modal" role="dialog" aria-modal="true" aria-label="Podgląd node'a planera">
        <div class="card-head">
          <div>
            <div class="card-title">${escapeHtml(node.label || node.id)}</div>
            <div class="meta">${escapeHtml(node.id)}</div>
          </div>
          <span class="tag">${escapeHtml(node.technology || node.kind || "node")}</span>
        </div>
        <p class="note">${escapeHtml(node.description || "Brak opisu.")}</p>
        <div class="planner-node-stats">
          <span class="field-pill inactive">input: ${inputCount}</span>
          <span class="field-pill inactive">output: ${outputCount}</span>
        </div>
        ${node.uri ? `<p class="meta"><strong>URI:</strong> ${escapeHtml(node.uri)}</p>` : ""}
        ${node.table ? `<p class="meta"><strong>Tabela:</strong> ${escapeHtml(node.table)}</p>` : ""}
        ${node.documentType ? `<p class="meta"><strong>Dokument:</strong> ${escapeHtml(node.documentType)}</p>` : ""}
        ${node.developerNotes ? `<p class="meta"><strong>Notatki:</strong> ${escapeHtml(node.developerNotes)}</p>` : ""}
        <section class="field-group">
          <h4>Input</h4>
          <div class="field-list">${plannerPreviewFieldPills(inputElements)}</div>
        </section>
        <section class="field-group">
          <h4>Output</h4>
          <div class="field-list">${plannerPreviewFieldPills(outputElements)}</div>
        </section>
        <div class="planner-node-modal-actions">
          <button type="button" data-planner-modal-close="1">Zamknij</button>
        </div>
      </div>
    `;
    document.body.appendChild(overlay);

    overlay.addEventListener("click", (event) => {
      const target = event.target;
      if (!(target instanceof HTMLElement)) {
        return;
      }
      if (target === overlay || target.closest("[data-planner-modal-close]")) {
        state.planner.previewNodeId = null;
        render();
        return;
      }
    });
  }

  function plannerPreviewFieldPills(elements) {
    if (!elements.length) {
      return "<span class='meta'>brak</span>";
    }
    return elements
      .map((element) => {
        const semanticRef = element.semanticRef || "";
        const field = semanticRef ? state.dataset.maps.fieldsById[semanticRef] : null;
        const label = element.label || element.id || semanticRef || "pole";
        const title = field
          ? `${field.label || semanticRef}${field.description ? ` — ${field.description}` : ""}`
          : semanticRef
            ? `semanticRef: ${semanticRef}`
            : label;
        return `<span class="field-pill inactive" title="${escapeHtml(title)}">${escapeHtml(label)}</span>`;
      })
      .join("");
  }

  function plannerBranchMiniItems(mainGraphNodeId, position, mainSet) {
    const branchEdges =
      position === "top"
        ? state.planner.edges.filter(
            (edge) => edge.toGraphNodeId === mainGraphNodeId && !mainSet.has(edge.fromGraphNodeId),
          )
        : state.planner.edges.filter(
            (edge) => edge.fromGraphNodeId === mainGraphNodeId && !mainSet.has(edge.toGraphNodeId),
          );

    if (!branchEdges.length) {
      return "<span class='planner-branch-placeholder'></span>";
    }

    return branchEdges
      .map((edge) => {
        const branchGraphNodeId = position === "top" ? edge.fromGraphNodeId : edge.toGraphNodeId;
        const branchGraphNode = plannerGraphNodeById(branchGraphNodeId);
        if (!branchGraphNode) {
          return "";
        }
        const branchNode = state.dataset.maps.nodesById[branchGraphNode.dataNodeId];
        const label = branchNode ? branchNode.label || branchNode.id : branchGraphNode.dataNodeId;
        const id = branchNode ? branchNode.id : branchGraphNode.dataNodeId;
        const shared = (edge.sharedFields || []).slice(0, 2).join(", ");
        return `
          <button type="button" class="planner-branch-mini" data-planner-set-root="${escapeHtml(branchGraphNodeId)}" title="${escapeHtml(
            `${label}${shared ? ` (${shared})` : ""}`,
          )}">
            <span class="planner-branch-mini-id">${escapeHtml(id)}</span>
            <span class="planner-branch-mini-details">${escapeHtml(label)}${shared ? ` • ${escapeHtml(shared)}` : ""}</span>
          </button>
        `;
      })
      .join("");
  }

  function plannerEdgesHtml() {
    if (!state.planner.edges.length) {
      return "<p class='meta'>Brak krawędzi. Dodaj kolejne node'y przyciskami +.</p>";
    }
    return state.planner.edges
      .map((edge) => {
        const from = plannerGraphNodeById(edge.fromGraphNodeId);
        const to = plannerGraphNodeById(edge.toGraphNodeId);
        if (!from || !to) {
          return "";
        }
        const fromNode = state.dataset.maps.nodesById[from.dataNodeId];
        const toNode = state.dataset.maps.nodesById[to.dataNodeId];
        return `<p class="meta">${escapeHtml(fromNode ? fromNode.id : from.dataNodeId)} -> ${escapeHtml(
          toNode ? toNode.id : to.dataNodeId,
        )} <span class="muted">(${escapeHtml((edge.sharedFields || []).slice(0, 2).join(", ") || "bez pól")})</span></p>`;
      })
      .join("");
  }

  function bindPlannerCanvasEvents() {
    const clearButton = SELECTORS.selectedCardPanel.querySelector("[data-planner-clear]");
    if (clearButton) {
      clearButton.addEventListener("click", () => {
        state.planner = createPlannerState();
        render();
      });
    }

    SELECTORS.selectedCardPanel.querySelectorAll("[data-planner-slot-target]").forEach((button) => {
      button.addEventListener("click", () => {
        const targetGraphNodeId = button.getAttribute("data-planner-slot-target");
        const side = button.getAttribute("data-planner-slot-side");
        if (!targetGraphNodeId || !side) {
          return;
        }
        state.planner.pendingAttach = { targetGraphNodeId, side };
        render();
      });
    });

    SELECTORS.selectedCardPanel.querySelectorAll("[data-planner-remove]").forEach((button) => {
      button.addEventListener("click", () => {
        const graphNodeId = button.getAttribute("data-planner-remove");
        if (!graphNodeId) {
          return;
        }
        removePlannerNode(graphNodeId);
        render();
      });
    });

    SELECTORS.selectedCardPanel.querySelectorAll("[data-planner-set-root]").forEach((button) => {
      button.addEventListener("click", () => {
        const graphNodeId = button.getAttribute("data-planner-set-root");
        if (!graphNodeId) {
          return;
        }
        state.planner.mainPathRootGraphNodeId = graphNodeId;
        render();
      });
    });

    SELECTORS.selectedCardPanel.querySelectorAll("[data-planner-candidate]").forEach((button) => {
      button.addEventListener("click", () => {
        const dataNodeId = button.getAttribute("data-planner-candidate");
        const targetGraphNodeId = button.getAttribute("data-planner-target");
        const side = button.getAttribute("data-planner-side");
        if (!dataNodeId || !side) {
          return;
        }
        addPlannerNode(targetGraphNodeId, side, dataNodeId);
        render();
      });
    });

    const addFirstButton = SELECTORS.selectedCardPanel.querySelector("[data-planner-add-first]");
    if (addFirstButton) {
      addFirstButton.addEventListener("click", () => {
        state.planner.pendingAttach = { targetGraphNodeId: null, side: "after" };
        render();
      });
    }
  }

  function renderPlannerInspector() {
    const yaml = plannerYamlPreview();
    SELECTORS.inspectorPanel.innerHTML = `
      <div class="planner-yaml-tools">
        <label class="label" for="planner-flow-id">Flow id</label>
        <input id="planner-flow-id" type="text" value="${escapeHtml(state.planner.flowMeta.id)}" />
        <label class="label" for="planner-flow-label">Flow label</label>
        <input id="planner-flow-label" type="text" value="${escapeHtml(state.planner.flowMeta.label)}" />
        <label class="label" for="planner-flow-description">Opis</label>
        <input id="planner-flow-description" type="text" value="${escapeHtml(state.planner.flowMeta.description)}" />
        <button type="button" class="entity-button" data-planner-save-yaml="1">Zapisz YAML</button>
      </div>
      <pre class="planner-yaml-preview">${escapeHtml(yaml)}</pre>
    `;

    const idInput = SELECTORS.inspectorPanel.querySelector("#planner-flow-id");
    const labelInput = SELECTORS.inspectorPanel.querySelector("#planner-flow-label");
    const descriptionInput = SELECTORS.inspectorPanel.querySelector("#planner-flow-description");
    const saveButton = SELECTORS.inspectorPanel.querySelector("[data-planner-save-yaml]");

    if (idInput) {
      idInput.addEventListener("input", () => {
        state.planner.flowMeta.id = idInput.value.trim() || "planner-generated-flow";
        renderPlannerInspector();
      });
    }
    if (labelInput) {
      labelInput.addEventListener("input", () => {
        state.planner.flowMeta.label = labelInput.value.trim() || "Planner Generated Flow";
        renderPlannerInspector();
      });
    }
    if (descriptionInput) {
      descriptionInput.addEventListener("input", () => {
        state.planner.flowMeta.description = descriptionInput.value.trim() || "Flow wygenerowany z Flow Planner.";
        renderPlannerInspector();
      });
    }
    if (saveButton) {
      saveButton.addEventListener("click", savePlannerYaml);
    }
  }

  function plannerYamlPreview() {
    const mainPathGraphNodeIds = plannerMainPathGraphNodeIds();
    const steps = mainPathGraphNodeIds
      .map((graphNodeId) => plannerGraphNodeById(graphNodeId))
      .filter(Boolean)
      .map((graphNode) => graphNode.dataNodeId);
    const lines = [
      `id: ${yamlScalar(state.planner.flowMeta.id)}`,
      `label: ${yamlScalar(state.planner.flowMeta.label)}`,
      `description: ${yamlScalar(state.planner.flowMeta.description)}`,
      "steps:",
    ];
    if (!steps.length) {
      lines.push("  []");
    } else {
      steps.forEach((stepNodeId) => {
        lines.push(`  - node: ${yamlScalar(stepNodeId)}`);
      });
    }
    return lines.join("\n");
  }

  function plannerMainPathGraphNodeIds() {
    const root =
      state.planner.mainPathRootGraphNodeId && plannerGraphNodeById(state.planner.mainPathRootGraphNodeId)
        ? state.planner.mainPathRootGraphNodeId
        : plannerGraphNodeEntries()[0]
          ? plannerGraphNodeEntries()[0].graphNodeId
          : null;
    if (!root) {
      return [];
    }

    const byFrom = {};
    state.planner.edges.forEach((edge) => {
      byFrom[edge.fromGraphNodeId] ||= [];
      byFrom[edge.fromGraphNodeId].push(edge.toGraphNodeId);
    });

    const memo = {};
    function longestPathFrom(nodeId, trail) {
      if (trail.has(nodeId)) {
        return [];
      }
      if (memo[nodeId]) {
        return memo[nodeId];
      }
      const nextNodes = byFrom[nodeId] || [];
      if (!nextNodes.length) {
        memo[nodeId] = [nodeId];
        return memo[nodeId];
      }
      const nextTrail = new Set(trail);
      nextTrail.add(nodeId);
      let best = [];
      for (const nextNodeId of nextNodes) {
        const path = longestPathFrom(nextNodeId, nextTrail);
        if (path.length > best.length) {
          best = path;
        }
      }
      memo[nodeId] = [nodeId, ...best];
      return memo[nodeId];
    }

    return longestPathFrom(root, new Set());
  }

  function savePlannerYaml() {
    const yaml = plannerYamlPreview();
    const blob = new Blob([yaml], { type: "text/yaml;charset=utf-8" });
    const url = URL.createObjectURL(blob);
    const link = document.createElement("a");
    const slug = (state.planner.flowMeta.id || "planner-generated-flow").replace(/[^a-zA-Z0-9_-]+/g, "-");
    link.href = url;
    link.download = `${slug}.yaml`;
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);
    URL.revokeObjectURL(url);
    setStatus(`Pobrano plik: ${slug}.yaml`);
  }

  function yamlScalar(value) {
    const normalized = String(value || "").replace(/\r?\n/g, " ").trim();
    return `'${normalized.replace(/'/g, "''")}'`;
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
    if (state.activeView === "planner") {
      const size = plannerGraphNodeEntries().length;
      SELECTORS.breadcrumbs.textContent = `Flow Planner / ${size} node'ów / ${state.planner.edges.length} połączeń`;
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
