---
name: dziennik-add-entry
description: Dodaje nowy wpis do dziennika użytkownika (apka Dziennik, projekt Supabase kkegymepatwufnemtldr, tabela public.notes). Użyj gdy użytkownik mówi "dodaj wpis", "zapisz w dzienniku", "notatka na 21.06", "dziś było...", albo opisuje swój dzień/nastrój i prosi o zapisanie. Domyślna data to dzisiaj; akceptuj też formaty typu "wczoraj", "21.06", "15 czerwca". Nastrój 1-5 wnioskujesz sam z tekstu — NIE pytaj użytkownika o ocenę.
---

# Skill: dodawanie wpisu do Dziennika

Zapisuje pojedynczą notatkę do `public.notes` w Supabase **przez REST API (PostgREST) z service-role secret key** — niezależnie od dostępności Supabase MCP.

## Autoryzacja

Dane uwierzytelniające trzymane są w pliku **`.claude/skills/dziennik-add-entry/credentials.local.json`** (gitignored, NIE komituj). Struktura:

```json
{
  "supabase_url": "https://<ref>.supabase.co",
  "supabase_secret_key": "sb_secret_...",
  "user_id": "<uuid>",
  "user_email": "..."
}
```

**Pierwszy krok każdego wywołania skilla:** wczytaj ten plik (np. `Read` na ścieżce `.claude/skills/dziennik-add-entry/credentials.local.json`) i wyciągnij `supabase_url`, `supabase_secret_key`, `user_id`. Jeśli plik nie istnieje — przerwij i powiedz użytkownikowi, że credentiale nie są skonfigurowane.

Sekret `sb_secret_...` to klucz service-role: bypassuje RLS. **Nigdy nie loguj go, nie wstawiaj do stdout w sposób który zostanie w transkrypcie**. Używaj tylko w nagłówkach HTTP.

## Reguły domeny (twarde)

- **Limit 5 notatek na dzień** (constraint `unique (user_id, date, position)`, position ∈ {1..5}).
- **Treść 1–500 znaków** (constraint `char_length between 1 and 500`).
- **Format daty:** `YYYY-MM-DD` (kolumna `date`, lokalna strefa użytkownika).
- **EDIT_WINDOW_DAYS = 7** w UI — wpisy starsze niż 7 dni dalej zapiszesz w bazie, ale w aplikacji będą tylko do odczytu. Ostrzeż użytkownika w takim wypadku.

## Wnioskowanie nastroju (1–5)

Wybierz jedną wartość, która najlepiej oddaje **dominujący ton** wpisu:

| Skala | Znaczenie | Słowa-klucze (przykłady) |
|------|-----------|--------------------------|
| 1 | bardzo źle | kryzys, beznadzieja, "nic mi się nie chce", smutek głęboki, lęk paraliżujący |
| 2 | źle | frustracja, zmęczenie, irytacja, rozdrażnienie, niepokój |
| 3 | neutralnie | rutyna, obojętność, "tak sobie", spokój pasywny |
| 4 | dobrze | zadowolenie, satysfakcja, ulga, optymizm, sens |
| 5 | bardzo dobrze | radość, euforia, wdzięczność, duma, podekscytowanie |

Jeśli wpis jest mieszany (np. "miałem dobry dzień, ale wieczorem padłem ze zmęczenia"), wybierz wartość średnią i wzmiankuj o tym w podsumowaniu dla użytkownika.

Wybierz też **jedno słowo-etykietę** po polsku oddającą ton (np. "satysfakcja", "zmęczenie", "wdzięczność") — pójdzie do nagłówka wpisu.

## Format treści w bazie

Sklej w jeden ciąg:

```
Nastrój: X/5 — <etykieta>. <oryginalny tekst użytkownika>
```

Przykład: `Nastrój: 4/5 — satysfakcja. Skończyłem projekt, który ciągnąłem od dwóch tygodni. Mogę wreszcie odetchnąć.`

Sprawdź, że całość mieści się w 500 znaków. Jeśli nie — przytnij tekst użytkownika do sensownej granicy (nie w środku słowa); ewentualnie zapytaj.

## Procedura (krok po kroku)

### 1. Wczytaj credentiale
`Read` ścieżki `.claude/skills/dziennik-add-entry/credentials.local.json`. Zapisz w zmiennych roboczych: `SUPABASE_URL`, `SECRET`, `USER_ID`.

### 2. Parsuj datę

- Dzisiaj → użyj dzisiejszej daty z kontekstu systemowego.
- "Wczoraj", "przedwczoraj", "X dni temu" → policz względem dzisiaj.
- "21.06", "15 czerwca" bez roku → załóż bieżący rok.
- "21.06.2026" / "2026-06-21" → użyj wprost.
- Data w przyszłości → przerwij, poproś o korektę.

Wynik: ciąg `<DATE>` w formacie `YYYY-MM-DD`.

### 3. Sprawdź zajęte sloty (GET)

```bash
curl -s "$SUPABASE_URL/rest/v1/notes?select=position&user_id=eq.$USER_ID&date=eq.$DATE&order=position.asc" \
  -H "apikey: $SECRET" \
  -H "Authorization: Bearer $SECRET"
```

Odpowiedź = JSON-array, np. `[{"position":1},{"position":3}]`. Wyciągnij liczby, sprawdź:
- Jeśli długość = 5 → przerwij: *"Na <DATE> jest już 5 notatek (limit dnia). Usuń jedną w aplikacji albo wybierz inną datę."*
- Najmniejsza nieobecna wartość z {1,2,3,4,5} = `<POSITION>` do wstawienia.

### 4. Wnioskuj nastrój (1–5) i etykietę, sklej treść (sekcja "Format treści") = `<CONTENT>`.

### 5. INSERT (POST z `Prefer: return=representation` żeby dostać wstawiony wiersz)

Najbezpieczniej zapisać payload do tmp-pliku (uniknie cytowania apostrofów i polskich znaków w shellu):

```bash
cat > /tmp/dziennik_note.json <<JSON
{"user_id":"$USER_ID","date":"$DATE","position":$POSITION,"content":"$CONTENT_JSON_ESCAPED"}
JSON

curl -s -X POST "$SUPABASE_URL/rest/v1/notes" \
  -H "apikey: $SECRET" \
  -H "Authorization: Bearer $SECRET" \
  -H "Content-Type: application/json" \
  -H "Prefer: return=representation" \
  --data-binary @/tmp/dziennik_note.json
```

`$CONTENT_JSON_ESCAPED` = treść po escapowaniu znaków JSON (`"` → `\"`, `\` → `\\`, znaki kontrolne). Najprościej: użyj `Write` do utworzenia pliku JSON z prawidłowym zserializowanym contentem zamiast walki z heredoc-iem.

Spodziewany 201 + body z polami `id, user_id, date, position, content, created_at, updated_at`. Zapisz `id` i `created_at` z odpowiedzi.

Jeśli HTTP ≠ 201:
- 409 z message zawierającym `notes_user_id_date_position_key` → race condition, ktoś (UI?) zajął ten slot między 3. a 5. Powtórz krok 3 i 5.
- 400/422 → pokaż treść błędu użytkownikowi, nie zgaduj.
- 401/403 → secret key prawdopodobnie błędny lub został unieważniony.

### 6. Weryfikacja — drugi GET

```bash
curl -s "$SUPABASE_URL/rest/v1/notes?select=id,date,position,content,created_at&id=eq.$INSERTED_ID" \
  -H "apikey: $SECRET" \
  -H "Authorization: Bearer $SECRET"
```

Sprawdź:
- Zwrócił dokładnie 1 wiersz.
- `content` == `<CONTENT>` z kroku 4 (porównanie znak-po-znaku).
- `date` == `<DATE>`, `position` == `<POSITION>`.
- `created_at` == to samo co dostałeś w kroku 5.

Jeśli którykolwiek warunek nie spełniony → zgłoś błąd użytkownikowi i pokaż surowy wynik.

### 7. Podsumowanie dla użytkownika

Jednym zdaniem, np.:
> Zapisałem na **2026-06-22** jako slot **2/5**, nastrój **4/5 (satysfakcja)**. Pełny tekst: *"Nastrój: 4/5 — satysfakcja. Skończyłem projekt…"*

Dodaj ostrzeżenie, jeśli data > 7 dni wstecz: *"Wpis jest poza oknem edycji aplikacji (7 dni) — w UI będzie tylko do odczytu, ale w bazie siedzi prawidłowo."*

## Czego NIE robić

- **Nie loguj secret key** w stdout (nawet jako część komendy curl w opisie tego co robisz dla użytkownika — pokazuj `$SECRET`, nie wartość).
- **Nie commituj** `credentials.local.json` (jest w `.gitignore`, ale uważaj).
- Nie pytaj użytkownika o ocenę nastroju — wnioskuj sam.
- Nie dodawaj komentarza terapeutycznego / interpretacji — to nie jest zadanie tego skilla. Tylko zapis.
- Nie wstawiaj kilku notatek naraz w jednym wywołaniu — jedno wywołanie = jeden wpis na jeden dzień. Jeśli użytkownik wkleja wiele wpisów dla wielu dni, wykonaj skill wielokrotnie (sekwencyjnie, weryfikując każdy).
- Nie używaj REST API do `PATCH` / `DELETE` — to skill *dodający*, nic więcej.

## Fallback: Supabase MCP

Jeśli REST API z jakiegoś powodu nie działa (firewall, DNS), a w sesji jest dostępny tool `mcp__cd76db1c-...__execute_sql`, możesz tym samym schematem zrobić INSERT przez SQL — ale to fallback, nie domyślna ścieżka. REST + secret key jest pierwszym wyborem, bo nie zależy od konfiguracji MCP.

## Przykład wywołania (dla testu)

> Użytkownik: *"dodaj wpis: pierwszy raz od dwóch tygodni przespałem 8 godzin. Czuję się jak nowo narodzony."*

Twoje kroki:
1. `Read` → credentials.local.json.
2. Data = dzisiaj (np. 2026-06-22).
3. GET sloty → np. `[{"position":1}]` → `<POSITION>` = 2.
4. Nastrój: **5/5 — wdzięczność** (radość + ulga z odpoczynku).
5. `<CONTENT>` = `Nastrój: 5/5 — wdzięczność. Pierwszy raz od dwóch tygodni przespałem 8 godzin. Czuję się jak nowo narodzony.`
6. POST → 201, `id` = `...`, `created_at` = `...`.
7. GET po `id` → wiersz pasuje znak-po-znaku.
8. *"Zapisałem na 2026-06-22 jako slot 2/5, nastrój 5/5 (wdzięczność). Tekst: 'Nastrój: 5/5 — wdzięczność. Pierwszy raz od dwóch tygodni przespałem 8 godzin. Czuję się jak nowo narodzony.'"*
