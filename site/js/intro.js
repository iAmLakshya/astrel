// Play the intro only when the viewer allows motion.
  if (!window.matchMedia("(prefers-reduced-motion: reduce)").matches) {
    document.documentElement.classList.add("intro");
  }
