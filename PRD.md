# PRD – Aplikacja "Dziennik" (notatki dzienne z kalendarzem)

## 1. Informacje ogólne

- **Nazwa robocza produktu:** Dziennik
- **Autor dokumentu:** Bartosz Kubiak
- **Data utworzenia:** 2026-06-19
- **Wersja dokumentu:** 1.0 (MVP)
- **Status:** Draft

## 2. Cel produktu

Stworzenie prostej aplikacji do prowadzenia codziennego dziennika, w której użytkownik może każdego dnia zapisać maksymalnie **5 krótkich notatek**, a następnie wracać do nich w dowolnym momencie dzięki widokowi kalendarza i historii wpisów.

Aplikacja ma zachęcać do regularnego, krótkiego zapisywania myśli – bez presji długiej formy.

## 3. Problem i uzasadnienie

Większość aplikacji do notatek jest "pusta" – pozwala napisać dowolnie dużo, w dowolnym miejscu, przez co użytkownik łatwo traci nawyk pisania. Z drugiej strony klasyczne dzienniki papierowe są niewyszukiwalne i niełatwo wracać do starszych wpisów.

"Dziennik" rozwiązuje to przez:
- ograniczenie do 5 notatek dziennie (mniej decyzji, łatwiej zacząć),
- jasne przypisanie wpisów do dnia w kalendarzu,
- szybkie przeglądanie historii.

## 4. Grupa docelowa

- Osoby chcące wyrobić nawyk codziennego zapisywania (selfcare, wdzięczność, plany).
- Użytkownicy, którzy nie potrzebują rozbudowanego edytora – wystarczy im krótka forma.
- Osoby ceniące prosty, czytelny interfejs.

## 5. Zakres MVP

### 5.1 Funkcje obowiązkowe (must have)

1. **Dodawanie notatek do bieżącego dnia**
   - Każda notatka to krótki tekst (np. do 500 znaków).
   - Maksymalnie 5 notatek na jeden dzień (kalendarzowy, lokalny czas użytkownika).
   - Po osiągnięciu limitu pole dodawania jest zablokowane z komunikatem: "Osiągnięto limit 5 notatek na dziś".

2. **Edycja i usuwanie notatek**
   - Edycja: dowolny dzień, dowolna notatka.
   - Usunięcie zwalnia slot – jeżeli dotyczy dzisiejszego dnia, można dodać nową notatkę w jego miejsce.

3. **Kalendarz**
   - Widok miesięczny z możliwością przejścia do dowolnego miesiąca (wstecz i naprzód).
   - Dni z co najmniej jedną notatką są wizualnie oznaczone (np. kropka pod datą lub wypełnione tło).
   - Kliknięcie w dzień otwiera widok notatek z tego dnia.

4. **Widok dnia**
   - Lista notatek z danego dnia (max 5).
   - Licznik wykorzystanych slotów (np. "3 / 5").
   - Akcje: dodaj, edytuj, usuń (dla dni bieżących i przeszłych – patrz pkt 6.2).

5. **Przeglądanie historii**
   - Z poziomu kalendarza – cofanie się do dowolnego dnia, w którym istnieją wpisy.
   - Opcjonalnie: lista chronologiczna "Ostatnie wpisy" na ekranie głównym.

6. **Lokalna trwałość danych**
   - Notatki zapisywane lokalnie (np. SQLite / IndexedDB / plik JSON – w zależności od stosu).
   - Dane przeżywają restart aplikacji.

### 5.2 Funkcje opcjonalne (nice to have, poza MVP)

- Wyszukiwarka pełnotekstowa po notatkach.
- Tagi / kategorie notatek.
- Eksport do PDF / Markdown.
- Synchronizacja w chmurze i logowanie.
- Przypomnienie push o zapisaniu notatki o ustalonej godzinie.
- Tryb ciemny.
- Statystyki (np. seria dni z wpisem, liczba notatek w miesiącu).

### 5.3 Poza zakresem

- Współdzielenie notatek między użytkownikami.
- Załączniki (zdjęcia, audio) – rozważyć w kolejnej wersji.
- Wersjonowanie / historia zmian pojedynczej notatki.

## 6. Wymagania funkcjonalne (szczegółowe)

### 6.1 Model danych

**Notatka (`Note`):**
- `id` – unikalny identyfikator (UUID).
- `date` – data wpisu (YYYY-MM-DD, lokalna strefa czasowa użytkownika).
- `position` – kolejność na liście danego dnia (1–5).
- `content` – treść (string, max 500 znaków).
- `createdAt` – znacznik czasu utworzenia.
- `updatedAt` – znacznik czasu ostatniej edycji.

**Ograniczenie:** dla danego `date` może istnieć maksymalnie 5 rekordów `Note`.

### 6.2 Reguły biznesowe

- Limit 5 notatek dotyczy **każdego dnia osobno** i jest egzekwowany w warstwie aplikacji oraz w warstwie danych (constraint / walidacja).
- Edycja i usuwanie wpisów z dni przeszłych jest dozwolona (użytkownik ma pełną kontrolę nad swoimi danymi).
- Notatka nie może być pusta (po przycięciu białych znaków minimum 1 znak).
- Data wpisu jest ustalana w momencie utworzenia notatki na podstawie lokalnego czasu urządzenia.

### 6.3 Ekrany (MVP)

1. **Ekran główny / Dziś**
   - Data dzisiejsza, licznik notatek (np. "2 / 5").
   - Lista dzisiejszych notatek.
   - Pole szybkiego dodawania (aktywne, dopóki < 5 notatek).
   - Skrót do kalendarza.

2. **Kalendarz**
   - Widok miesiąca, nawigacja ◀ / ▶.
   - Oznaczenie dni z wpisami.
   - Klik w dzień → "Widok dnia".

3. **Widok dnia (historia)**
   - Nagłówek z datą.
   - Lista notatek + akcje (edytuj / usuń).
   - Możliwość dodania nowej notatki tylko jeśli to dzień dzisiejszy i `liczba < 5`.

4. **Edycja notatki** (modal lub osobny widok)
   - Pole tekstowe z licznikiem znaków.
   - Akcje: Zapisz / Anuluj / Usuń.

## 7. Wymagania niefunkcjonalne

- **Wydajność:** otwarcie kalendarza i widoku dnia < 200 ms przy do 5 lat historii notatek.
- **Dostępność:** podstawowa zgodność z WCAG AA (kontrast, nawigacja klawiaturą, etykiety pól).
- **Lokalizacja:** interfejs po polsku (MVP). Architektura przygotowana na dodanie kolejnych języków.
- **Prywatność:** w MVP wszystkie dane lokalnie na urządzeniu. Brak telemetrii bez zgody użytkownika.
- **Niezawodność:** brak utraty danych przy nagłym zamknięciu (zapis po każdej zmianie).

## 8. Stos technologiczny (propozycja)

Do uzgodnienia, ale rekomendacja dla MVP:
- **Frontend:** React + TypeScript (lub React Native, jeśli celem jest mobile).
- **Stan / dane:** lokalna baza – IndexedDB (web) lub SQLite (mobile/desktop).
- **Build:** Vite (web) lub Expo (mobile).
- **Styl:** Tailwind CSS lub natywne komponenty platformy.

## 9. Kryteria akceptacji MVP

- [ ] Użytkownik może dodać 1–5 notatek do dzisiejszego dnia.
- [ ] Po dodaniu 5. notatki dalsze dodawanie jest zablokowane z czytelnym komunikatem.
- [ ] Notatki przeżywają restart aplikacji.
- [ ] W kalendarzu wizualnie oznaczone są dni z wpisami.
- [ ] Klikając dzień w kalendarzu, użytkownik widzi listę notatek z tego dnia.
- [ ] Notatki z dni przeszłych można edytować i usuwać.
- [ ] Limit 5 notatek na dzień obowiązuje również dla dni edytowanych w przeszłości.
- [ ] Interfejs w języku polskim, czytelny na ekranach od 360 px szerokości.

## 10. Metryki sukcesu

- DAU / WAU (procent dni z co najmniej jednym wpisem na użytkownika).
- Średnia liczba notatek na dzień aktywności.
- Retencja D7 / D30 (czy użytkownik wraca po tygodniu / miesiącu).
- Czas od instalacji do pierwszej zapisanej notatki (target: < 60 s).

## 11. Ryzyka i otwarte pytania

- **Strefy czasowe / podróże:** jak liczyć "dzień", jeśli użytkownik zmienia strefę? (MVP: lokalna strefa urządzenia w momencie zapisu).
- **Wielourządzeniowość:** MVP nie obsługuje synchronizacji – do zaadresowania w v2.
- **Limit 500 znaków:** wartość do potwierdzenia z użytkownikami (możliwe 280 lub 1000).
- **Backup:** czy w MVP udostępnić ręczny eksport JSON na wypadek utraty urządzenia?

## 12. Roadmapa (orientacyjnie)

- **v1.0 (MVP):** dodawanie/edycja/usuwanie notatek, limit 5/dzień, kalendarz, historia, lokalna persistencja.
- **v1.1:** tryb ciemny, eksport JSON/Markdown, wyszukiwanie.
- **v1.2:** przypomnienia push, statystyki, seria dni.
- **v2.0:** konto użytkownika, synchronizacja w chmurze, załączniki.
