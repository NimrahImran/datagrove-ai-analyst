/* Contact form: validates and sends to /api/contact */
(function () {
  var form = document.getElementById('contactForm');
  if (!form) return;
  var err = document.getElementById('cErr');
  var btn = document.getElementById('cBtn');
  var sent = document.getElementById('cSent');
  var label = btn.innerHTML;

  form.addEventListener('input', function () { err.textContent = ''; });

  form.addEventListener('submit', function (e) {
    e.preventDefault();
    var data = Object.fromEntries(new FormData(form).entries());
    if (!data.name.trim()) { err.textContent = 'Please enter your name.'; form.name.focus(); return; }
    if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(data.email.trim())) { err.textContent = 'Please enter a valid email address.'; form.email.focus(); return; }
    if (data.message.trim().length < 10) { err.textContent = 'Please write a message of at least 10 characters.'; form.message.focus(); return; }

    btn.disabled = true;
    btn.textContent = 'Sending…';
    fetch('/api/contact', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(data)
    })
      .then(function (r) { return r.json().then(function (j) { return { ok: r.ok, body: j }; }); })
      .then(function (res) {
        if (res.ok && res.body.ok) {
          form.reset();
          sent.hidden = false;
        } else {
          err.textContent = (res.body && (res.body.error || res.body.detail)) || 'Could not send your message. Please try again.';
        }
      })
      .catch(function () { err.textContent = 'Network error. Please check your connection and try again.'; })
      .finally(function () { btn.disabled = false; btn.innerHTML = label; });
  });

  document.getElementById('cAgain').addEventListener('click', function () { sent.hidden = true; });
})();
