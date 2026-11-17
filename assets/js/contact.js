/* Contact form
 * 1) Sends through our API (Gmail).
 * 2) If that is not available, sends straight from the browser through
 *    Web3Forms using a public form key (the owner's email is never in the page).
 */
(function () {
  var form = document.getElementById('contactForm');
  if (!form) return;
  var err = document.getElementById('cErr');
  var btn = document.getElementById('cBtn');
  var sent = document.getElementById('cSent');
  var label = btn.innerHTML;
  var configPromise = fetch('/api/contact-config').then(function (r) { return r.ok ? r.json() : {}; }).catch(function () { return {}; });

  form.addEventListener('input', function () { err.textContent = ''; });

  function viaApi(data) {
    return fetch('/api/contact', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(data)
    }).then(function (r) { return r.json().then(function (j) { return r.ok && j.ok; }); }).catch(function () { return false; });
  }

  function viaWeb3Forms(key, data) {
    return fetch('https://api.web3forms.com/submit', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
      body: JSON.stringify({
        access_key: key,
        subject: '[Datagrove] ' + (data.subject || 'New message') + ' — from ' + data.name,
        from_name: 'Datagrove Contact',
        name: data.name,
        email: data.email,
        replyto: data.email,
        message: data.message,
        botcheck: data.website || ''
      })
    }).then(function (r) { return r.json(); }).then(function (j) { return !!(j && j.success); }).catch(function () { return false; });
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
    viaApi(data)
      .then(function (ok) {
        if (ok) return true;
        return configPromise.then(function (cfg) { return cfg && cfg.web3forms_key ? viaWeb3Forms(cfg.web3forms_key, data) : false; });
      })
      .then(function (ok) {
        if (ok) { form.reset(); sent.hidden = false; }
        else err.textContent = 'Could not send your message right now. Please try again in a moment.';
      })
      .finally(function () { btn.disabled = false; btn.innerHTML = label; });
  });

  document.getElementById('cAgain').addEventListener('click', function () { sent.hidden = true; });
})();
