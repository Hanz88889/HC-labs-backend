# HC Labs Repository Cleanup

## Hasil audit

Backend memiliki satu Worker runtime, tiga adapter media/LLM, router Brain, konfigurasi Wrangler, dan regression tests. Seluruh file tersebut masih direferensikan oleh import atau route aktif. Tidak ada adapter atau route produksi yang dihapus karena masih memiliki fungsi jelas.

Frontend hanya berisi SPA `index.html` dan asset logo brand yang terpisah. CSS selector `.glass`, `.tab`, dan `.tab-active` sebelumnya dideklarasikan dua kali; deklarasi yang tertimpa sudah digabung agar satu sumber style tetap aktif.

Dokumentasi `HC_LABS_*.md` dipertahankan karena berisi schema, architecture, validation, security, adapter, workflow, dan deployment notes untuk handoff ke repository akun utama.

## Validasi handoff

- Backend test suite harus lulus.
- Semua modul Worker harus lulus `node --check`.
- Frontend inline JavaScript harus dapat dikompilasi dengan `new Function`.
- Frontend brand block harus memakai `assets/brand/hc-labs-logo.png`.
- Tidak ada secret provider/admin dalam source repository.
