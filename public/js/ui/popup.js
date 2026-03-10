// ===== BEEP SOUND =====
function playBeep() {
  try {
    var ctx = new (window.AudioContext || window.webkitAudioContext)();
    var osc = ctx.createOscillator();
    var gain = ctx.createGain();
    osc.connect(gain);
    gain.connect(ctx.destination);
    osc.frequency.value = 880;
    osc.type = 'sine';
    gain.gain.value = 0.3;
    osc.start();
    osc.stop(ctx.currentTime + 0.3);
    setTimeout(function() {
      var osc2 = ctx.createOscillator();
      var gain2 = ctx.createGain();
      osc2.connect(gain2);
      gain2.connect(ctx.destination);
      osc2.frequency.value = 1100;
      osc2.type = 'sine';
      gain2.gain.value = 0.3;
      osc2.start();
      osc2.stop(ctx.currentTime + 0.3);
    }, 350);
  } catch (e) {}
}

// ===== ERROR TOASTS =====
function showErrorToast(message, type) {
  var toast = document.createElement('div');
  toast.className = 'error-toast' + (type === 'warn' ? ' warn' : '');
  toast.innerHTML = escapeHtml(message) + '<button class="error-toast-close" onclick="dismissToast(this)">&times;</button>';
  toastContainer.appendChild(toast);

  // Auto-dismiss after 6 seconds
  setTimeout(function() {
    if (toast.parentNode) {
      toast.style.animation = 'toastOut 0.3s ease-in forwards';
      setTimeout(function() { toast.remove(); }, 300);
    }
  }, 6000);
}

function dismissToast(btn) {
  var toast = btn.parentNode;
  toast.style.animation = 'toastOut 0.3s ease-in forwards';
  setTimeout(function() { toast.remove(); }, 300);
}
