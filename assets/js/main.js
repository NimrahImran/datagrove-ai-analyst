/* Shared behaviour: mobile menu, scroll reveal, hero effects */
(function () {
  var btn = document.querySelector('.menu-btn');
  var menu = document.getElementById('mobileMenu');
  if (btn && menu) {
    btn.addEventListener('click', function () {
      var open = menu.classList.toggle('open');
      btn.setAttribute('aria-expanded', open);
      btn.setAttribute('aria-label', open ? 'Close menu' : 'Open menu');
    });
  }

  // Reveal sections as they scroll into view
  var items = document.querySelectorAll('.reveal');
  if ('IntersectionObserver' in window) {
    var io = new IntersectionObserver(function (entries) {
      entries.forEach(function (e) {
        if (e.isIntersecting) { e.target.classList.add('in'); io.unobserve(e.target); }
      });
    }, { threshold: 0.12 });
    items.forEach(function (el) { io.observe(el); });
  } else {
    items.forEach(function (el) { el.classList.add('in'); });
  }

  // Hero: falling light particles + gentle 3D parallax
  var motes = document.getElementById('motes');
  if (motes) {
    for (var i = 0; i < 14; i++) {
      var m = document.createElement('i');
      m.style.left = 'calc(var(--bx) + ' + ((Math.random() - 0.5) * 12).toFixed(1) + '%)';
      m.style.animationDuration = (3 + Math.random() * 3) + 's';
      m.style.animationDelay = (-Math.random() * 6) + 's';
      var s = 2 + Math.random() * 3;
      m.style.width = m.style.height = s + 'px';
      motes.appendChild(m);
    }
  }
  var hero = document.getElementById('hero');
  var art = document.getElementById('art');
  var copy = document.getElementById('copy');
  if (hero && art && window.matchMedia('(pointer:fine)').matches) {
    hero.addEventListener('mousemove', function (e) {
      if (window.innerWidth <= 860) return;
      var r = hero.getBoundingClientRect();
      var x = (e.clientX - r.left) / r.width - 0.5;
      var y = (e.clientY - r.top) / r.height - 0.5;
      art.style.transform = 'scale(1.04) translate(' + (-x * 16) + 'px,' + (-y * 12) + 'px) rotateY(' + (x * 2) + 'deg) rotateX(' + (-y * 2) + 'deg)';
      if (copy) copy.style.transform = 'translateY(-46%) translate(' + (x * 8) + 'px,' + (y * 6) + 'px)';
    });
    hero.addEventListener('mouseleave', function () {
      art.style.transform = '';
      if (copy) copy.style.transform = '';
    });
  }
})();
