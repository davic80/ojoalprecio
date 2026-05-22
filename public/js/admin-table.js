/* eslint-env browser */
/**
 * Reusable admin-table behavior: column sort + multi-select with bulk actions.
 *
 * Markup contract:
 *   <table class="price-table" data-admin-table>           ← table with this attr
 *     <thead>
 *       <tr>
 *         <th class="select-col"><input type="checkbox" data-select-all></th>
 *         <th class="sortable-col" data-col="name">Name</th>
 *         <th class="sortable-col" data-col="price" data-default-sort="desc">Price</th>
 *         ...
 *       </tr>
 *     </thead>
 *     <tbody>
 *       <tr data-id="123" data-name="..." data-price="42.5"> ← data-<col> per sort col
 *         <td><input type="checkbox" class="row-select" value="123"></td>
 *         ...
 *       </tr>
 *     </tbody>
 *   </table>
 *
 * Notes:
 *   - data-default-sort="desc" on a <th> marks the initial sort column + direction.
 *   - Sort auto-detects numeric vs string by sniffing the first row's value.
 *   - For string sort the dataset value is used as-is (use localeCompare).
 *   - Selection state lives on `window.AdminTable.get(tableEl)` and the table
 *     element dispatches `admin-table-selection` (CustomEvent) on every change
 *     with detail = { selected: Set<string>, count }. Bulk-action UI binds to
 *     that event to enable/disable + update the count label.
 *
 * Bulk action wiring:
 *   <div class="bulk-bar" data-admin-bulk-bar-for="<tableId>">
 *     <span data-bulk-count></span>
 *     <button data-bulk-action="delete">Delete</button>
 *   </div>
 *   The bulk-bar's data-admin-bulk-bar-for attribute must match the
 *   parent table's `id`. The bar is auto-shown/hidden based on selection
 *   count; each action button is disabled when count = 0.
 */

(function () {
  if (window.AdminTable) return;   // idempotent — load-once

  function init(table) {
    if (table._adminTableInit) return;
    table._adminTableInit = true;

    const tbody     = table.querySelector('tbody');
    const headers   = [...table.querySelectorAll('th.sortable-col')];
    const selectAll = table.querySelector('th.select-col input[data-select-all]');
    const selected  = new Set();

    // ── sort ──────────────────────────────────────────────────────────────
    let sortCol = null, sortDir = -1;
    const defaultHeader = headers.find(h => h.dataset.defaultSort);
    if (defaultHeader) {
      sortCol = defaultHeader.dataset.col;
      sortDir = defaultHeader.dataset.defaultSort === 'asc' ? 1 : -1;
    }

    function sniffType(col) {
      const first = tbody.querySelector('tr');
      if (!first) return 'string';
      const v = first.dataset[col];
      return v != null && v !== '' && !isNaN(parseFloat(v)) ? 'number' : 'string';
    }

    function applySort() {
      if (!sortCol) return;
      const type = sniffType(sortCol);
      const rows = [...tbody.querySelectorAll('tr')];
      rows.sort(function (a, b) {
        const va = a.dataset[sortCol];
        const vb = b.dataset[sortCol];
        if (type === 'number') {
          return sortDir * ((parseFloat(va) || 0) - (parseFloat(vb) || 0));
        }
        return sortDir * String(va ?? '').localeCompare(String(vb ?? ''), 'es', { sensitivity: 'base' });
      });
      rows.forEach(r => tbody.appendChild(r));
      headers.forEach(h => h.classList.remove('sort-asc', 'sort-desc'));
      const active = headers.find(h => h.dataset.col === sortCol);
      if (active) active.classList.add(sortDir === 1 ? 'sort-asc' : 'sort-desc');
    }

    headers.forEach(h => {
      h.addEventListener('click', function () {
        const col = h.dataset.col;
        if (sortCol === col) sortDir *= -1;
        else { sortCol = col; sortDir = sniffType(col) === 'number' ? -1 : 1; }
        applySort();
      });
    });
    applySort();

    // ── selection ─────────────────────────────────────────────────────────
    function fireChange() {
      table.dispatchEvent(new CustomEvent('admin-table-selection', {
        bubbles: true,
        detail: { selected: new Set(selected), count: selected.size },
      }));
    }

    function syncCheckboxes() {
      tbody.querySelectorAll('.row-select').forEach(cb => {
        cb.checked = selected.has(cb.value);
      });
      if (selectAll) {
        const visible = [...tbody.querySelectorAll('.row-select')];
        selectAll.checked = visible.length > 0 && visible.every(cb => selected.has(cb.value));
        selectAll.indeterminate = !selectAll.checked && visible.some(cb => selected.has(cb.value));
      }
    }

    tbody.addEventListener('change', function (e) {
      const cb = e.target;
      if (!cb.classList.contains('row-select')) return;
      if (cb.checked) selected.add(cb.value);
      else selected.delete(cb.value);
      syncCheckboxes();
      fireChange();
    });

    if (selectAll) {
      selectAll.addEventListener('change', function () {
        const want = selectAll.checked;
        tbody.querySelectorAll('.row-select').forEach(cb => {
          if (want) selected.add(cb.value);
          else selected.delete(cb.value);
        });
        syncCheckboxes();
        fireChange();
      });
    }

    // ── bulk-bar binding (auto-wire by data-admin-bulk-bar-for=tableId) ──
    if (table.id) {
      const bar = document.querySelector(`[data-admin-bulk-bar-for="${table.id}"]`);
      if (bar) {
        const countEl = bar.querySelector('[data-bulk-count]');
        const actions = [...bar.querySelectorAll('[data-bulk-action]')];
        table.addEventListener('admin-table-selection', function (e) {
          const n = e.detail.count;
          if (countEl) countEl.textContent = n > 0 ? `${n} seleccionad${n === 1 ? 'o' : 'os'}` : '';
          actions.forEach(b => { b.disabled = n === 0; });
          bar.classList.toggle('bulk-bar-active', n > 0);
        });
        // initial state
        actions.forEach(b => { b.disabled = true; });
      }
    }

    // expose selection state so view-specific scripts can read it
    table._adminTableState = { selected, sync: syncCheckboxes, clear: function () { selected.clear(); syncCheckboxes(); fireChange(); } };
  }

  window.AdminTable = {
    init,
    get: function (table) { return table._adminTableState || null; },
    initAll: function () { document.querySelectorAll('table[data-admin-table]').forEach(init); },
  };

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', window.AdminTable.initAll);
  } else {
    window.AdminTable.initAll();
  }
})();
