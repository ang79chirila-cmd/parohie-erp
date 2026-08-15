# ParohieERP — aplicație desktop (Electron)

Acest folder transformă prototipul React `ParohieERP.jsx` într-o aplicație
desktop de sine stătătoare, instalabilă pe Windows, macOS sau Linux, care
rulează fără server și fără conexiune la internet.

## Ce s-a schimbat față de prototip

Singura diferență față de fișierul original este mecanismul de persistență.
Prototipul salva datele prin `window.storage` (API specific mediului Claude).
Aici, `window.storage` este re-creat identic (aceleași metode: `get`, `set`,
`delete`, `list`), dar în spate scrie într-un fișier JSON de pe discul local,
în directorul standard de date al aplicației:

- Windows: `%APPDATA%\ParohieERP\parohie-store.json`
- macOS: `~/Library/Application Support/ParohieERP/parohie-store.json`
- Linux: `~/.config/ParohieERP/parohie-store.json`

Codul aplicației (`src/ParohieERP.jsx`) este **neschimbat** față de fișierul
pe care l-ai încărcat — nu a fost necesară nicio modificare de logică.

## Cerințe

- [Node.js](https://nodejs.org) versiunea 18 sau mai recentă (LTS recomandat)
- Conexiune la internet **doar** pentru pasul de instalare a dependențelor
  (`npm install`) — după aceea aplicația rulează complet offline

## Instalare

```bash
cd parohie-erp-desktop
npm install
```

## Rulare în modul dezvoltare

```bash
npm run dev
```

Aceasta pornește serverul Vite (cu reîncărcare instantă la modificări) și
deschide fereastra Electron peste el. Util dacă vrei să continui să
modifici codul.

## Rulare simplă, fără mod dezvoltare

```bash
npm run build
npm start
```

## Generarea unui instalator (aplicație "de sine stătătoare")

```bash
npm run dist
```

Rezultatul apare în folderul `release/`:

- Windows → un instalator `.exe` (NSIS)
- macOS → un fișier `.dmg`
- Linux → un `.AppImage`

**Important**: `electron-builder` construiește implicit instalatorul pentru
sistemul de operare pe care rulează comanda. Pentru un `.exe` funcțional ai
nevoie să rulezi `npm run dist` pe Windows (sau într-un mediu de build cross
compilat pentru Windows); similar pentru `.dmg` pe macOS. Dacă ai nevoie de
instalatoare pentru mai multe sisteme de operare din alt SO decât cel țintă,
spune-mi și configurăm build cross-platform (necesită unelte suplimentare,
ex. Wine pe Linux pentru target Windows).

## Backup și migrare a datelor

Fișierul de stocare locală (`parohie-store.json`) conține întreaga bază de
date a parohiei. În plus, din tab-ul **Date parohie** al aplicației există
funcția integrată de export/import JSON, recomandată pentru backup regulat
și pentru mutarea datelor pe alt calculator, independent de calea de sistem
de mai sus.

## Structura proiectului

```
parohie-erp-desktop/
├── electron/
│   ├── main.js       # proces principal Electron: fereastră + storage local (IPC)
│   └── preload.js    # expune window.storage în renderer, izolat contextual
├── src/
│   ├── ParohieERP.jsx  # componenta originală, neschimbată
│   ├── main.jsx         # montează React în #root
│   └── index.css        # directive Tailwind
├── index.html
├── vite.config.js
├── tailwind.config.js
├── postcss.config.js
└── package.json
```
