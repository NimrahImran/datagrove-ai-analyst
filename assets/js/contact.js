/* Contact form
 * 1) Sends through FormSubmit (formsubmit.co) straight from the browser.
 *    The destination comes from the server at send time and is never written in the page.
 * 2) If FormSubmit is unavailable, falls back to our own API (Gmail).
 */
(function () {
  var form = document.getElementById('contactForm');
  if (!form) return;
  var err = document.getElementById('cErr');
  var btn = document.getElementById('cBtn');
  var sent = document.getElementById('cSent');
  var label = btn.innerHTML;

  form.addEventListener('input', function () { err.textContent = ''; });

  function postJson(url, body) {
    return fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
      body: JSON.stringify(body)
    }).then(function (r) { return r.json().then(function (j) { return { ok: r.ok, body: j }; }); });
  }

  function viaFormSubmit(data) {
    return postJson('/api/contact/route', { name: data.name, email: data.email, message: data.message })
      .then(function (res) {
        if (!res.ok || !res.body.target) return false;
        return postJson('https://formsubmit.co/ajax/' + encodeURIComponent(res.body.target), {
          name: data.name,
          email: data.email,
          _replyto: data.email,
          _subject: '[Datagrove] ' + (data.subject || 'New message') + ' — from ' + data.name,
          _template: 'table',
          _captcha: 'false',
          _honey: data.website || '',
          subject: data.subject || '-',
          message: data.message
        }).then(function (r) {
          var s = r.body && String(r.body.success);
          // First message ever asks the owner to activate the form by email: treat as received.
          return r.ok && (s === 'true' || /activat/i.test(r.body.message || ''));
        });
      })
      .catch(function () { return false; });
  }

  function viaApi(data) {
    return postJson('/api/contact', data).then(function (r) { return r.ok && r.body.ok; }).catch(function () { return false; });
  }

  form.addEventListener('submit', function (e) {
    e.preventDefault();
    var data = Object.fromEntries(new FormData(form).entries());
    if (!data.name.trim()) { err.textContent = 'Please enter your name.'; form.name.focus(); return; }
    if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(data.email.trim())) { err.textContent = 'Please enter a valid email address.'; form.email.focus(); return; }
    if (data.message.trim().length < 10) { err.textContent = 'Please write a message of at least 10 characters.'; form.message.focus(); return; }
    if (data.website) { form.reset(); sent.hidden = false; return; } // bot trap

    btn.disabled = true;
    btn.textContent = 'Sending…';
    viaFormSubmit(data)
      .then(function (ok) { return ok || viaApi(data); })
      .then(function (ok) {
        if (ok) { form.reset(); sent.hidden = false; }
        else err.textContent = 'Could not send your message right now. Please try again in a moment.';
      })
      .finally(function () { btn.disabled = false; btn.innerHTML = label; });
  });

  document.getElementById('cAgain').addEventListener('click', function () { sent.hidden = true; });
})();
