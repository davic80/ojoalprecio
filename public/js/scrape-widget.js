(function () {
  const widget = document.getElementById('scrape-widget');
  if (!widget) return;

  let dropdown = null;
  let open = false;

  function render(s) {
    if (!s.isRunning) {
      widget.innerHTML = '';
      open = false;
      return;
    }

    const pct = s.total > 0 ? Math.round((s.done / s.total) * 100) : 0;
    const label = s.total > 0 ? s.done + '/' + s.total : '…';

    if (!widget.querySelector('#scrape-btn')) {
      widget.innerHTML =
        '<button id="scrape-btn" style="' +
          'background:#1d4ed8;color:#fff;border:none;border-radius:6px;' +
          'padding:4px 10px;font-size:12px;cursor:pointer;display:flex;align-items:center;gap:6px;' +
          'white-space:nowrap' +
        '">' +
          '<span style="display:inline-block;width:10px;height:10px;border-radius:50%;' +
            'border:2px solid #fff;border-top-color:transparent;animation:spin .8s linear infinite"></span>' +
          '<span id="scrape-label"></span>' +
        '</button>' +
        '<div id="scrape-drop" style="' +
          'display:none;position:absolute;right:0;top:calc(100% + 6px);' +
          'background:#fff;border:1px solid #e5e7eb;border-radius:8px;' +
          'box-shadow:0 4px 16px rgba(0,0,0,.12);min-width:320px;max-width:420px;z-index:999;' +
          'font-size:13px;overflow:hidden' +
        '"></div>';

      document.getElementById('scrape-btn').addEventListener('click', function (e) {
        e.stopPropagation();
        open = !open;
        document.getElementById('scrape-drop').style.display = open ? 'block' : 'none';
      });
      document.addEventListener('click', function () {
        open = false;
        const d = document.getElementById('scrape-drop');
        if (d) d.style.display = 'none';
      });
    }

    document.getElementById('scrape-label').textContent = '🔄 ' + label;

    if (open) renderDropdown(s, pct);
  }

  function renderDropdown(s, pct) {
    const d = document.getElementById('scrape-drop');
    if (!d) return;

    let html =
      '<div style="padding:12px 16px;border-bottom:1px solid #f0f0f0">' +
        '<div style="display:flex;justify-content:space-between;margin-bottom:6px;font-weight:600;color:#111">' +
          '<span>Escaneando productos</span><span>' + s.done + '/' + s.total + '</span>' +
        '</div>' +
        '<div style="height:6px;background:#e5e7eb;border-radius:3px;overflow:hidden">' +
          '<div style="height:100%;width:' + pct + '%;background:#1d4ed8;transition:width .3s"></div>' +
        '</div>' +
      '</div>';

    if (s.current) {
      html +=
        '<div style="padding:10px 16px;background:#eff6ff;border-bottom:1px solid #dbeafe;color:#1d4ed8;font-weight:500">' +
          '⟳ ' + esc(s.current.name || s.current.asin) +
        '</div>';
    }

    if (s.log.length > 0) {
      html += '<div style="max-height:260px;overflow-y:auto">';
      s.log.forEach(function (entry) {
        const ago = Math.round((Date.now() - entry.ts) / 1000);
        const agoStr = ago < 60 ? ago + 's' : Math.round(ago / 60) + 'm';
        html +=
          '<div style="padding:7px 16px;display:flex;justify-content:space-between;align-items:center;border-bottom:1px solid #f9fafb">' +
            '<span style="overflow:hidden;text-overflow:ellipsis;white-space:nowrap;max-width:260px;color:' + (entry.ok ? '#374151' : '#b91c1c') + '">' +
              (entry.ok ? '✓' : '✗') + ' ' + esc(entry.name || entry.asin) +
            '</span>' +
            '<span style="color:#9ca3af;font-size:11px;margin-left:8px;flex-shrink:0">' + agoStr + '</span>' +
          '</div>';
      });
      html += '</div>';
    }

    d.innerHTML = html;
  }

  function esc(str) {
    return String(str).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  }

  async function poll() {
    try {
      const res = await fetch('/admin/scrape-status');
      if (res.ok) render(await res.json());
    } catch (_) {}
  }

  const style = document.createElement('style');
  style.textContent = '@keyframes spin{to{transform:rotate(360deg)}}';
  document.head.appendChild(style);

  poll();
  setInterval(poll, 5000);
})();
