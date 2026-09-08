# Upstream fixes: anulowanie uploadu + OOM przeglądarki przy dużych plikach

Raport przeniesiony z **discordrive** (repo `Magiszonekk/discordrive`, branch
`fix/upload-cancel-and-oom`, commit `8f846f0`) do oceny, czy te same poprawki
są potrzebne w **ddrive**.

Data: 2026-09-08
Autor analizy: agent pracujący na discordrive-prod (OVH)
Status w discordrive: wdrożone na produkcję i zweryfikowane
Status w ddrive: **nie tknięte — do decyzji zespołu ddrive**

---

## TL;DR dla agenta ddrive

Sprawdziłem kod ddrive (`/home/ubuntu/Desktop/ddrive-work/target`, branch `main`).
Z czterech defektów naprawionych w discordrive:

| # | Defekt | Występuje w ddrive? | Priorytet |
|---|--------|---------------------|-----------|
| A1 | `AbortSignal` nie dociera do `fetch()` — anulowanie nie działa | **TAK, 1:1** | wysoki |
| A2 | Kontroler gubiony przy zamianie `placeholderId` → `realFileId` | **TAK, 1:1** | wysoki |
| A3 | Anulowanie raportowane jako `FAILED` (brak `CANCELLED`) | **TAK, 1:1** | średni |
| B | Chunker O(n²) — realokacja całego bufora przy każdym read | **TAK, plik identyczny** | wysoki |
| C | Sztywne `defaultUploadConcurrency: 20` bez budżetu pamięci | **TAK** | średni |
| A2b | Zbędna kopia `ciphertextBuffer` trzymana przez retry | **NIE** (ddrive nie ma E2EE) | — |

Wniosek: **wszystkie defekty poza jednym występują w ddrive.** ddrive ma
łagodniejszy profil pamięciowy (2 kopie chunka zamiast 4, bo nie szyfruje
po stronie klienta), ale defekt chunkera jest identyczny co do znaku, a
problem z anulowaniem uploadu jest w 100% ten sam.

---

## Kontekst — jak to wyszło

Użytkownik zgłosił dwie rzeczy na produkcji discordrive:

1. „klikam X podczas wysyłania pliku i tak jakby nic się nie działo”
2. „wgrywałem ~55 GB i przy ~90% wszystko się wyjebało, przeglądarka
   wywaliła out of memory”

Obie okazały się realnymi defektami kodu, nie kwestią sprzętu czy rozmiaru
pliku.

---

## Defekt A — anulowanie uploadu nie działa

### A1: `AbortSignal` nigdy nie trafia do `fetch()`

`apps/frontend/src/lib/api.ts` w ddrive (linie 27-30, 53-60):

```ts
export interface BlobUploadRequestOptions {
  extraHeaders?: Record<string, string>;
  authToken?: string;
  // <-- brak signal
}

const response = await fetch(`${API_BASE}/api/blob/${blobId}`, {
  method: "PUT",
  headers: { ...authHeaders, "Content-Type": "application/octet-stream", ...(options.extraHeaders ?? {}) },
  body: toUploadBody(data),
  // <-- brak signal
});
```

`controller.abort()` ustawia flagę, ale **trwający PUT leci do końca**, bo
przeglądarka nie ma jak go przerwać. `withChunkRetry()` sprawdza
`signal.aborted` wyłącznie *między* próbami:

```ts
async function withChunkRetry<T>(fn: () => Promise<T>, signal: AbortSignal): Promise<T> {
  for (let attempt = 0; attempt < CHUNK_MAX_ATTEMPTS; attempt++) {
    if (signal.aborted) throw new DOMException("Upload aborted", "AbortError");
    try { return await fn(); }   // <-- fn() jest nieprzerywalne
    ...
```

Przy chunku 8 MiB i storage'u Discord (~2-4 s/chunk) daje to kilka sekund,
w których UI wygląda jakby przycisk był martwy — pasek postępu dalej rośnie.

**Uwaga:** w ddrive `fetchBlobBody` (download) **już ma** `signal`. Defekt
dotyczy wyłącznie ścieżki uploadu — dokładnie tak samo było w discordrive.

### A2: kontroler ginie przy zamianie ID

`apps/frontend/src/lib/upload.ts` w ddrive (linie 165-197):

```ts
store.addUpload(placeholderId, totalBlobs, file.size, file.name);
store.registerController(placeholderId, controller);      // rejestracja #1
...
const realFileId = initUpload.fileId;
store.removeUpload(placeholderId);   // <-- kasuje TAKŻE kontroler z mapy
store.registerController(realFileId, controller);          // rejestracja #2
```

`removeUpload` robi `uploadControllers.delete(fileId)`. W oknie między
`initUpload` a ponowną rejestracją klik w X trafia w nieistniejący wpis, a
`cancelUpload` używa `?.abort()`:

```ts
cancelUpload: (fileId) => uploadControllers.get(fileId)?.abort(),
```

— czyli **cicho nic**, bez błędu w konsoli. To jest ta druga, trudniejsza do
zauważenia ścieżka: anulowanie w fazie przygotowania pliku.

### A3: anulowanie wygląda jak błąd

`UploadStatus` w ddrive (`packages/types/src/index.ts`) nie ma `CANCELLED`:

```ts
export enum UploadStatus {
  PENDING, UPLOADING, COMMITTING_MANIFEST, DONE, FAILED
}
```

`catch` ustawia `FAILED` (upload.ts:442), więc świadome anulowanie przez
użytkownika jest nieodróżnialne od realnej awarii — mylące w UI i zaśmieca
telemetrię.

### Jak naprawione w discordrive

- `BlobUploadRequestOptions` dostało `signal?: AbortSignal` przekazywane do
  `fetch()`, plus `signal: controller.signal` w **obu** call-site'ach
  (chunk + manifest).
- Dodany `UploadStatus.CANCELLED`.
- `cancelUpload` w store od razu ustawia status `CANCELLED` zamiast czekać, aż
  pipeline się rozwinie; `updateUpload` dostało guard traktujący `CANCELLED`
  jako terminalny — bez niego spóźnione update'y z rozwijającego się pipeline'u
  przywracały `UPLOADING`.
- `upload.ts` sprawdza `controller.signal.aborted` po zamianie ID
  (`cancelledDuringInit`) i rozróżnia `AbortError` od realnego błędu
  (`upload_session_cancelled` vs `upload_session_failed`).
- `UploadProgress.tsx` traktuje `CANCELLED` jako nieaktywny: chowa X, zeruje
  speed/ETA, auto-dismiss po 3 s, neutralny kolor zamiast czerwonego.

---

## Defekt B — chunker O(n²) w realokacjach

**`packages/processing/src/chunker.ts` w ddrive jest bajt w bajt identyczny
z wersją sprzed naprawy w discordrive.**

```ts
let buffer = new Uint8Array(0);
while (true) {
  const { done, value } = await reader.read();     // ~64 KiB na read
  if (done) break;
  const newBuffer = new Uint8Array(buffer.length + value.length);
  newBuffer.set(buffer, 0);        // <-- przepisuje WSZYSTKO zbuforowane
  newBuffer.set(value, buffer.length);
  buffer = newBuffer;
  ...
```

Przy każdym odczycie ze strumienia realokowany jest cały bufor i kopiowany od
nowa. To O(n²) w liczbie odczytów na chunk.

### Zmierzone (symulacja pętli, Node/V8)

| plik | chunków | zaalokowano | amplifikacja |
|------|---------|-------------|--------------|
| 1 GiB | 128 | 64.5 GiB | **x64.5** |
| 10 GiB | 1280 | 645 GiB | **x64.5** |
| 55 GiB | 7040 | 3547 GiB | **x64.5** |

### Benchmark realnego kodu (przed vs po, 1.5 GiB)

```
PRZED (kod z produkcji): 16.93 s →   91 MiB/s
PO   (bufor stały):       0.53 s → 2911 MiB/s     = 32x szybciej
```

Heap pozostaje płaski (GC nadąża), więc **to nie jest bezpośrednia przyczyna
OOM** — ale generuje ogromną presję na GC i fragmentację, co przy wielogigowych
plikach istotnie pogarsza sprawę. To też realny problem wydajnościowy sam w
sobie: chunkowanie 55 GB marnuje ~3.5 TiB przepustowości pamięci.

### Naprawa

Akumulator stałego rozmiaru `chunkSize`, wypełniany in-place:

```ts
let acc = new Uint8Array(chunkSize);
let accLen = 0;
// ...
let offset = 0;
while (offset < value.length) {
  const take = Math.min(chunkSize - accLen, value.length - offset);
  acc.set(value.subarray(offset, offset + take), accLen);
  accLen += take; offset += take;
  if (accLen === chunkSize) {
    yield { index, data: acc };
    acc = new Uint8Array(chunkSize);   // nowy bufor na każdy yield!
    accLen = 0; index++;
  }
}
// ogon:
if (accLen > 0) yield { index, data: acc.slice(0, accLen) };
```

### DWIE PUŁAPKI — konieczne do zachowania

1. **Każdy yield musi dostać WŁASNY bufor.** Chunker jest współdzielony —
   w ddrive używają go `apps/frontend/src/lib/upload.ts`,
   `apps/frontend/src/sw/stream-sw.ts` oraz `scripts/benchmark-browser-e2e.ts`.
   Ten ostatni robi `for await (...) plaintextChunks.push(chunk)` — zbiera
   chunki do tablicy. Recykling jednego bufora **po cichu zaliasowałby
   wszystkie zebrane chunki** do tej samej zawartości. Testy jednostkowe tego
   nie złapią, bo operują na małych danych w jednym chunku.

2. **Ogon przez `.slice()`, nie `subarray()`.** `subarray` zwróciłby widok
   pinujący pełny bufor `chunkSize` dla potencjalnie kilkubajtowej reszty.

Testy `packages/processing/src/__tests__/chunker.test.ts` przechodzą bez zmian
(w discordrive: 8/8, całość pakietu 35/35).

---

## Defekt C — sztywne concurrency bez budżetu pamięci

`packages/config/src/index.ts` → `defaultUploadConcurrency: 20`, użyte wprost
w `upload.ts:213` jako `const CONCURRENCY = config.defaultUploadConcurrency`.

Problem: **concurrency nie jest bezpiecznym pokrętłem**, bo żywa pamięć skaluje
się z `concurrency * chunkSize * liczba_kopii`. Przy pliku 55 GB nie ma
znaczenia, że plik jest streamowany — liczy się ile chunków wisi jednocześnie.

### Naprawa w discordrive

Nowy `config.uploadInFlightBudgetBytes`, a `upload.ts` wylicza:

```ts
const CONCURRENCY = Math.max(
  2,
  Math.min(
    config.defaultUploadConcurrency,
    Math.floor(config.uploadInFlightBudgetBytes / (LEGACY_UPLOAD_CHUNK_SIZE_BYTES * 2)),
  ),
);
```

**Wartość dobrana pomiarem, nie preferencją.** Zmierzone warianty dla
discordrive (4 kopie → po naprawie 2 kopie/chunk):

| budżet | workers | PEAK | pokrywa 8 webhooków? |
|--------|---------|------|----------------------|
| 96 MiB | 6 | 533 MiB | NIE — dusi fan-out |
| 128 MiB | 8 | 629 MiB | TAK |
| **192 MiB** | **12** | **869 MiB** | **TAK ← wybrane** |
| 256 MiB | 16 | 1109 MiB | TAK |
| *przed* | *20* | *1605 MiB* | *TAK* |

Kluczowy kompromis: pula Discorda ma 8 webhooków. Zejście do 6 workerów
udusiłoby fan-out (istotny dla throughputu uploadu), więc 192 MiB / 12 workerów
zachowuje pełny fan-out przy ~870 MiB zamiast ~1.5 GB.

---

## Co to znaczy konkretnie dla ddrive

ddrive **nie ma E2EE**, więc `uploadChunk` trzyma **2 kopie** chunka, nie 4:

```ts
const chunkBuffer = chunk.data.buffer.slice(...);   // kopia
await uploadBlobToApi(blobId, chunkBuffer, {...});
```

Brak `encryptFileContentChunk` → brak `ciphertext` i `ciphertextBuffer`.
Za to `chunkBuffer` jest **zbędny tak samo jak w discordrive** — `fetch`
kopiuje body wewnętrznie, więc `.buffer.slice()` to czysty narzut.

### Zmierzony profil pamięciowy ddrive (2 kopie, chunk 8 MiB)

```
OBECNIE  conc=20, 2 kopie : PEAK 1029 MiB
budżet 192 MiB -> conc=12 : PEAK  677 MiB
budżet 256 MiB -> conc=16 : PEAK  965 MiB
```

Czyli ddrive **też przekracza 1 GB żywej pamięci** przy domyślnym concurrency —
mniej niż discordrive (1605 MiB), ale nadal wystarczająco, by wysadzić kartę
przy dużym pliku, zwłaszcza gdy użytkownik ma otwarte inne zakładki.

### Rekomendowana kolejność dla ddrive

1. **A1 + A2 + A3 (anulowanie)** — najtańsze, czysty zysk UX, zero wpływu na
   throughput. Defekt jest 1:1, patch przenosi się niemal dosłownie.
2. **B (chunker)** — plik identyczny, patch przenosi się dosłownie. Duży zysk
   wydajnościowy (32x na chunkowaniu), zero ryzyka funkcjonalnego pod warunkiem
   zachowania obu pułapek wyżej.
3. **Usunięcie `chunkBuffer`** — jednolinijkowe (`uploadBlobToApi(blobId, chunk.data, ...)`),
   wymaga rozszerzenia typu parametru (patrz pułapka TS niżej).
4. **C (budżet concurrency)** — wymaga decyzji produktowej, bo obniża
   równoległość. Sprawdźcie ile webhooków ma pula ddrive
   (`grep -c WEBHOOK_ .env` na `ddrive-prod`) i dobierzcie budżet tak, żeby
   workers ≥ liczba webhooków.

---

## Pułapki techniczne (oszczędzą czas przy przenoszeniu)

### 1. TypeScript 5.7+: `BufferSource` nie zadziała

Naturalny odruch to zmienić sygnaturę na `BufferSource`. **Nie przejdzie
typechecku:**

```
error TS2345: Argument of type 'Uint8Array<ArrayBufferLike>' is not assignable
to parameter of type 'BufferSource'.
  Type 'SharedArrayBuffer' is missing the following properties from type
  'ArrayBuffer': resizable, resize, detached, transfer, transferToFixedLength
```

Powód: w TS 5.7+ `Uint8Array` jest parametryzowany (`Uint8Array<ArrayBufferLike>`),
a `ArrayBufferLike` obejmuje `SharedArrayBuffer`. Rozwiązanie — jawna unia:

```ts
type UploadBody = ArrayBuffer | Uint8Array<ArrayBufferLike>;
```

W `crypto.subtle.encrypt` potrzebny jest jeszcze `chunk as BufferSource`
(runtime akceptuje każdy widok, to wyłącznie zawężenie typu).

### 2. Weryfikacja w zminifikowanym bundlu

Vite **nie zwija** `192 * 1024 * 1024` do `201326592`. Grepowanie rozwiniętej
liczby daje 0 trafień i fałszywy wniosek „fix nie wszedł”. Grepuj wyrażenie:

```bash
grep -o 'uploadInFlightBudgetBytes:192\*1024\*1024' dist/assets/main-*.js
grep -o 'body:[a-zA-Z]*([a-z]),signal:[a-z]\.signal' dist/assets/main-*.js
```

### 3. Sam `grep CANCELLED` nie dowodzi, że fix działa

Status w bundlu może być z UI, a `signal` nadal nie trafiać do `fetch`.
Weryfikuj osobno **call-site** (`signal:y.signal` w wywołaniu uploadu) i
**implementację** (`signal:r.signal` w `fetch`).

### 4. Shadow `.js` sidecars

W discordrive historycznie zdarzały się pliki `.js` obok `.ts` w
`apps/frontend/src/`, które wygrywały w runtime i powodowały, że zmiany w `.ts`
„nie wchodziły”. W tej sesji `lib/` i `stores/` ich nie miały, ale warto
sprawdzić przed debugowaniem „build przeszedł, a nic się nie zmieniło”.

---

## Weryfikacja przeprowadzona w discordrive

- `tsc --noEmit` — czysty
- `packages/processing`: **35/35** testów zielonych (w tym 8 testów chunkera i
  wektory kryptograficzne — istotne, bo zmiana dotykała `encryptChunk`)
- build → nowy hash bundla, `index.html` serwuje nowy asset
- weryfikacja w minifikacie: `signal:r.signal` w PUT `/api/blob/`,
  `signal:y.signal` w obu call-site'ach, `uploadInFlightBudgetBytes:192*1024*1024`
- live: `https://discordrive.cikowice.pl` serwuje nowy bundel, HTTP 200

**Czego NIE zweryfikowano:** realnego uploadu 55 GB z przeglądarki. Pomiary
pamięci to symulacje ścieżki w V8 (ten sam silnik co Chrome) plus benchmark
prawdziwego kodu chunkera. Matematyka i kod się zgadzają, ale ostateczny dowód
wymaga transferu wielogigowego pliku przez realną kartę.

---

## Źródła

- Repo: `https://github.com/Magiszonekk/discordrive`
- Branch: `fix/upload-cancel-and-oom`
- Commit: `8f846f0` — *fix(upload): honour cancel mid-request and stop OOMing on huge files*
- Diff: 9 plików, +150 / −36

Pliki zmienione (ścieżki identyczne w ddrive poza `crypto.ts`, którego ddrive
nie potrzebuje):

```
apps/frontend/src/lib/api.ts                        (signal + typ body)
apps/frontend/src/lib/upload.ts                     (signal, cancel, concurrency, kopie)
apps/frontend/src/lib/crypto.ts                     (typ — NIE DOTYCZY ddrive)
apps/frontend/src/stores/upload.ts                  (CANCELLED + guard)
apps/frontend/src/components/files/UploadProgress.tsx (UI stanu CANCELLED)
packages/processing/src/chunker.ts                  (bufor stały)
packages/processing/src/crypto.ts                   (typ — NIE DOTYCZY ddrive)
packages/config/src/index.ts                        (uploadInFlightBudgetBytes)
packages/types/src/index.ts                         (UploadStatus.CANCELLED)
```

Aby zobaczyć konkretny diff:

```bash
git fetch origin fix/upload-cancel-and-oom
git show 8f846f0 -- packages/processing/src/chunker.ts
git show 8f846f0 -- apps/frontend/src/lib/api.ts
```
