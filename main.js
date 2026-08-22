/* ==========================================================
   BUCKHORN RANCH — main.js
   ========================================================== */

'use strict';

/* ----------------------------------------------------------
   AUDIO TOGGLE
   ---------------------------------------------------------- */
(function initAudio() {
  const toggle  = document.getElementById('audio-toggle');
  const audio   = document.getElementById('ambient-audio');
  const STORAGE = 'br_audio';

  if (!toggle || !audio) return;

  let isPlaying   = false;
  let fadeTimeout = null;
  let wasPlaying  = false; // track state before tab blur

  // Hide toggle if audio fails to load
  audio.addEventListener('error', () => {
    toggle.classList.add('hidden');
  }, { once: true });

  // Also hide if the source can't be fetched (404 etc.)
  const testAudioLoad = () => {
    // We probe for the file with a HEAD-like fetch
    fetch('/audio/ambient.mp3', { method: 'HEAD' })
      .then(res => { if (!res.ok) toggle.classList.add('hidden'); })
      .catch(()  => toggle.classList.add('hidden'));
  };
  testAudioLoad();

  function fadeIn(duration) {
    clearTimeout(fadeTimeout);
    audio.volume = 0;
    audio.play().catch(() => toggle.classList.add('hidden'));
    const steps = 30;
    const step  = duration / steps;
    const target = 0.25;
    let count = 0;
    const tick = setInterval(() => {
      count++;
      audio.volume = Math.min(target, (count / steps) * target);
      if (count >= steps) clearInterval(tick);
    }, step);
  }

  function fadeOut(duration) {
    clearTimeout(fadeTimeout);
    const startVol = audio.volume;
    const steps = 20;
    const step  = duration / steps;
    let count = 0;
    const tick = setInterval(() => {
      count++;
      audio.volume = Math.max(0, startVol * (1 - count / steps));
      if (count >= steps) {
        clearInterval(tick);
        audio.pause();
      }
    }, step);
  }

  toggle.addEventListener('click', () => {
    if (isPlaying) {
      isPlaying = false;
      toggle.classList.remove('playing');
      fadeOut(800);
    } else {
      isPlaying = true;
      toggle.classList.add('playing');
      fadeIn(1500);
    }
    try { localStorage.setItem(STORAGE, isPlaying ? '1' : '0'); } catch (_) {}
  });

  // Pause on tab blur, resume only if user had it playing
  document.addEventListener('visibilitychange', () => {
    if (document.hidden) {
      wasPlaying = isPlaying;
      if (isPlaying) {
        audio.pause();
      }
    } else {
      if (wasPlaying) {
        audio.play().catch(() => {});
      }
    }
  });
})();

/* ----------------------------------------------------------
   GALLERY LIGHTBOX
   ---------------------------------------------------------- */
(function initLightbox() {
  const lightbox   = document.getElementById('lightbox');
  const backdrop   = document.getElementById('lightbox-backdrop');
  const inner      = document.getElementById('lightbox-inner');
  const img        = document.getElementById('lightbox-img');
  const placeholder= document.getElementById('lightbox-placeholder');
  const caption    = document.getElementById('lightbox-caption');
  const prevBtn    = document.getElementById('lightbox-prev');
  const nextBtn    = document.getElementById('lightbox-next');
  const closeBtn   = document.getElementById('lightbox-close');
  const galleryGrid= document.getElementById('gallery-grid');

  if (!lightbox || !galleryGrid) return;

  let items       = [];
  let currentIdx  = 0;
  let touchStartX = 0;
  let touchEndX   = 0;

  // Build items list
  function buildItems() {
    items = Array.from(galleryGrid.querySelectorAll('.gallery-item'));
  }

  function showItem(index) {
    currentIdx = ((index % items.length) + items.length) % items.length;
    const item    = items[currentIdx];
    const imgEl   = item.querySelector('img');
    const capText = item.dataset.caption || '';

    caption.textContent = capText;

    // Use real image if available
    const hasSrc = imgEl && imgEl.getAttribute('src');
    if (hasSrc) {
      img.src = imgEl.src;
      img.alt = imgEl.alt || capText;
      img.classList.add('loaded');
      placeholder.style.display = 'none';
    } else {
      img.src = '';
      img.classList.remove('loaded');
      placeholder.style.display = 'block';
    }
  }

  function openLightbox(index) {
    buildItems();
    showItem(index);
    lightbox.classList.add('open');
    document.body.style.overflow = 'hidden';
    closeBtn.focus();
  }

  function closeLightbox() {
    lightbox.classList.remove('open');
    document.body.style.overflow = '';
    img.src = '';
  }

  // Clicks on gallery items
  galleryGrid.addEventListener('click', (e) => {
    const item = e.target.closest('.gallery-item');
    if (!item) return;
    const index = parseInt(item.dataset.index, 10);
    openLightbox(isNaN(index) ? 0 : index);
  });

  prevBtn.addEventListener('click', () => showItem(currentIdx - 1));
  nextBtn.addEventListener('click', () => showItem(currentIdx + 1));

  backdrop.addEventListener('click', closeLightbox);
  closeBtn.addEventListener('click', closeLightbox);

  // Keyboard
  document.addEventListener('keydown', (e) => {
    if (!lightbox.classList.contains('open')) return;
    if (e.key === 'Escape')      closeLightbox();
    if (e.key === 'ArrowLeft')   showItem(currentIdx - 1);
    if (e.key === 'ArrowRight')  showItem(currentIdx + 1);
  });

  // Touch swipe
  lightbox.addEventListener('touchstart', (e) => {
    touchStartX = e.changedTouches[0].screenX;
  }, { passive: true });

  lightbox.addEventListener('touchend', (e) => {
    touchEndX = e.changedTouches[0].screenX;
    const diff = touchStartX - touchEndX;
    if (Math.abs(diff) > 40) {
      diff > 0 ? showItem(currentIdx + 1) : showItem(currentIdx - 1);
    }
  }, { passive: true });
})();

/* ----------------------------------------------------------
   INTERSECTION OBSERVER — scroll-triggered animations
   ---------------------------------------------------------- */
(function initScrollAnimations() {
  const ease = 'cubic-bezier(0.25, 0.46, 0.45, 0.94)';

  // Animate-block: text sections
  const blockObserver = new IntersectionObserver((entries) => {
    entries.forEach(entry => {
      if (entry.isIntersecting) {
        entry.target.classList.add('visible');
        blockObserver.unobserve(entry.target);
      }
    });
  }, { threshold: 0.12 });

  document.querySelectorAll('.animate-block').forEach(el => {
    blockObserver.observe(el);
  });

  // Animate-image: lodge / gallery images
  const imgObserver = new IntersectionObserver((entries) => {
    entries.forEach(entry => {
      if (entry.isIntersecting) {
        entry.target.classList.add('visible');
        imgObserver.unobserve(entry.target);
      }
    });
  }, { threshold: 0.08 });

  document.querySelectorAll('.animate-image').forEach(el => {
    imgObserver.observe(el);
  });

  // Gallery items: stagger on entry
  const galleryObserver = new IntersectionObserver((entries) => {
    entries.forEach(entry => {
      if (entry.isIntersecting) {
        const index = parseInt(entry.target.dataset.index, 10) || 0;
        const delay = (index % 3) * 80; // stagger within row
        entry.target.style.transitionDelay = delay + 'ms';
        entry.target.classList.add('visible');
        galleryObserver.unobserve(entry.target);
      }
    });
  }, { threshold: 0.1, rootMargin: '0px 0px -40px 0px' });

  document.querySelectorAll('.gallery-item').forEach(el => {
    galleryObserver.observe(el);
  });

  // Pricing table rows: sequential fade
  const pricingObserver = new IntersectionObserver((entries) => {
    entries.forEach(entry => {
      if (entry.isIntersecting) {
        const table = entry.target;
        const rows  = table.querySelectorAll('tbody tr');
        rows.forEach((row, i) => {
          setTimeout(() => {
            row.classList.add('visible');
          }, i * 40);
        });
        pricingObserver.unobserve(table);
      }
    });
  }, { threshold: 0.1 });

  document.querySelectorAll('.pricing-table').forEach(table => {
    pricingObserver.observe(table);
  });

  // Lodge images: stagger
  const lodgeObserver = new IntersectionObserver((entries) => {
    let delay = 0;
    entries.forEach(entry => {
      if (entry.isIntersecting) {
        entry.target.style.transitionDelay = delay + 'ms';
        entry.target.classList.add('visible');
        delay += 100;
        lodgeObserver.unobserve(entry.target);
      }
    });
  }, { threshold: 0.08 });

  document.querySelectorAll('.lodge-item').forEach(el => {
    el.classList.add('animate-image');
    lodgeObserver.observe(el);
  });
})();

/* ----------------------------------------------------------
   LAZY LOAD — native loading="lazy" fallback + observer
   ---------------------------------------------------------- */
(function initLazyImages() {
  // Add loading="lazy" to all gallery/lodge images that get real src later
  document.querySelectorAll('.gallery-item img, .lodge-item img').forEach(img => {
    img.setAttribute('loading', 'lazy');
  });
})();
