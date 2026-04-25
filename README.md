# Holocron

Statyczna aplikacja webowa do **dokumentowania i eksploracji** narzędzi używanych w testach integracyjnych: wywołania API, zapytania do bazy, kolejki MQ/Kafka, dokumenty XML/JSON, pola i przepływy między nimi. Nie zastępuje testów ani dokumentacji zewnętrznych systemów — pomaga **nie zgubić się** w rosnącej liczbie endpointów, tabel i integracji spiętych w kodzie testów.

---

## Dlaczego to jest

W dużych suite’ach integracyjnych pojawia się coraz więcej „klocków”: kolejne API do wysłania transakcji, odczytu stanu, seedowania danych, topiców wiadomości itd. Holocron trzyma o nich wiedzę w **YAML** i pozwala ją przeglądać jak **bibliotekę kart** z wyszukiwaniem, flowami i powiązaniami pól — bez backendu i bez build stepu.

---

## Stack techniczny

| Warstwa | Technologia |
|--------|-------------|
| Hostowanie | Statyczne pliki (np. **GitHub Pages** z katalogu `docs/`) |
| Dane | **YAML**, ładowane przez `fetch()` |
| Parser YAML | **js-yaml** (CDN) |
| Wyszukiwarka | **lunr.js** (CDN) |
| UI | **HTML + CSS + JavaScript** (bez bundlera, bez Node jako serwera) |

---

## Uruchomienie lokalnie

Aplikacja ładuje dane przez `fetch()` — **nie wystarczy** otworzyć `index.html` z dysku (`file://`), bo przeglądarka zablokuje żądania do plików YAML.

**Prosty serwer HTTP** (jednorazowo, z katalogu repo):

```bash
# Python 3
python -m http.server 8080 --directory docs

# lub Node (tylko jako statyczny serwer, nie jako część aplikacji)
npx --yes serve docs -p 8080
```

Następnie wejdź w przeglądarce na: `http://localhost:8080/`

---

## Struktura repozytorium

```text
docs/
  index.html          # punkt wejścia
  assets/
    app.js            # logika: ładowanie YAML, widoki, wyszukiwarka
    style.css         # wygląd
  data/
    manifest.yaml     # lista plików nodes / fields / flows
    nodes/            # karty bytów (API, DB, MQ, XML, …)
    fields/           # koncepcje pól (FieldConcept) — opcjonalnie
    flows/            # przepływy end-to-end
```

Źródłem prawdy dla aplikacji jest **`docs/data/`**. Rootowe `data/` (jeśli istnieje) nie jest używane przez `docs/index.html`.

---

## Model danych (skrót)

### Node (karta)

Opisuje jeden byt używany w testach, np. endpoint, zapytanie, wiadomość, dokument XML. Typowe pola:

- `id`, `label`, `kind`, `technology` (`api`, `db`, `mq`, `xml`, …)
- `description`, `developerNotes`
- `uri`, `table`, `documentType` — zależnie od typu
- `elements` — lista pól wejścia/wyjścia powiązanych z tym bytem
- `implementationFiles` (opcjonalnie) — **mapowanie do plików w repo testów** (mapper, model, factory, klient HTTP itd.)

### FieldConcept (`fields/`)

Globalny opis pola ważnego semantycznie lub przepływowo. Jeśli element na karcie ma `semanticRef` wskazujący na istniejący wpis w `fields`, pole jest **klikalne** i można zobaczyć szczegóły oraz dalsze użycia. Jeśli **nie** ma odpowiadającego wpisu w `fields`, pole nadal jest widoczne na karcie, ale **nie** jest rozwijalne — żeby nie wymagać setek plików `fields` dla każdego drobiazgu API.

### Flow (`flows/`)

Kroki przepływu (`steps` z `node`, `consumes`, `produces`) — do nawigacji po scenariuszach end-to-end.

### `manifest.yaml`

Listy ścieżek do plików w `nodes/`, `fields/`, `flows/`.

---

## Interfejs użytkownika

- **Karty / Pola / Flow** — przełącznik nad główną treścią; lewa kolumna to katalog wybranego typu.
- **Środek** — podział na:
  - **górę**: jedna wybrana karta (lub podsumowanie pola/flow),
  - **dół**: szczegóły zaznaczenia (np. pole z opisem i listą miejsc, gdzie jeszcze występuje).
- Wyszukiwarka i filtr typu (API/DB/MQ/XML) działają w kontekście widoku **Karty**.

---

## GitHub Pages

Repozytorium można skonfigurować tak, by Pages serwował katalog **`/docs`** z gałęzi domyślnej. Po publikacji aplikacja działa pod adresem projektu Pages; pamiętaj, że ścieżki do YAML są względne do `docs/` (już ustawione w `app.js`).

---

## Rozwój

- Nowe byty: dodaj plik w `docs/data/nodes/`, wpisz go w `docs/data/manifest.yaml`.
- Nowe przepływy: `docs/data/flows/` + manifest.
- Wspólne pola semantyczne: `docs/data/fields/` + `semanticRef` w `elements` node’a.
- Pliki Java w testach: uzupełnij `implementationFiles` na karcie node’a.

Pull requesty warto utrzymywać z krótkim opisem **co** dodajesz do wiedzy i **dlaczego** (który scenariusz testowy).

---

## Licencja

Jeśli repozytorium ma mieć licencję, dodaj plik `LICENSE` i zaktualizuj tę sekcję.
