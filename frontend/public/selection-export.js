(() => {
    const selectionCount = document.querySelector('#selection-count');
    const selectionStores = {
        'homr-devs-crossstaff-keep': 'cross-staff-reranking-regenerated-current-runtime-systems',
        'homr-devs-page-delta-keep': 'whole-page-426-to-arm-a-output-change',
    };

    const selectedExamples = () => {
        const selected = [];
        for (let index = 0; index < localStorage.length; index += 1) {
            const key = localStorage.key(index);
            if (key?.startsWith('homr-keep-') && localStorage.getItem(key) === '1') selected.push({ key });
        }
        for (const [key, gallery] of Object.entries(selectionStores)) {
            try {
                const saved = JSON.parse(localStorage.getItem(key) || '{}');
                for (const [id, kept] of Object.entries(saved)) if (kept) selected.push({ gallery, id });
            } catch {
                // A malformed saved preference should not block the download.
            }
        }
        return selected.sort((left, right) => JSON.stringify(left).localeCompare(JSON.stringify(right)));
    };

    const updateSelectionCount = () => {
        selectionCount.textContent = `${selectedExamples().length} selected`;
    };

    document.querySelector('#export-selections').addEventListener('click', () => {
        const payload = {
            format: 'homr-example-selection@1',
            exported_at: new Date().toISOString(),
            selected_examples: selectedExamples(),
        };
        const blob = new Blob([`${JSON.stringify(payload, null, 2)}\n`], { type: 'application/json' });
        const url = URL.createObjectURL(blob);
        const link = document.createElement('a');
        link.href = url;
        link.download = 'homr-selected-examples.json';
        link.click();
        URL.revokeObjectURL(url);
    });

    window.addEventListener('storage', updateSelectionCount);
    updateSelectionCount();
})();
