// Display-only tooltip follows the existing dynamic account label.
(() => {
    const subtitle = document.getElementById('dispatch-sub-title');
    if (!subtitle) return;
    const updateTitle = () => { subtitle.title = subtitle.textContent.trim(); };
    updateTitle();
    new MutationObserver(updateTitle).observe(subtitle, { childList: true, characterData: true, subtree: true });
})();
