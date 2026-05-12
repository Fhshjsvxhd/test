'use strict';

// Replace macros like {clickid}, {sub1}, {country}, {device} in offer URLs.
function render(template, click) {
  if (!template) return '';
  return template.replace(/\{(\w+)\}/g, (_, key) => {
    const v = click[key];
    return v == null ? '' : encodeURIComponent(String(v));
  });
}

module.exports = { render };
