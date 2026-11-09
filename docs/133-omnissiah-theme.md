# 133 · Тема Omnissiah и как добавлять темы

**Что это.** Четвертая тема в настройках профиля (аватар → Settings → Theme): **Omnissiah**, теплая темная палитра Adeptus Mechanicus - сажа, кость, латунь, кармин и медь; сталь, патина и олива для холодных ролей. Источник цветов - палитра владельца `themes/omnissiah/colors.toml` в `personal_config_agent` (терминал, nvim, VS Code).

## Палитра

| Роль | Цвет | Откуда |
| --- | --- | --- |
| Фон / поверхность | `#121010` / `#1b1715` | `background` / `light_background` |
| Текст / вторичный / приглушенный | `#e6d3b3` / `#d9c4a3` / `#b39a7d` | между `foreground` и `bright_foreground`; `foreground`; светлее `muted` |
| Акцент-текст, фокус, план на графиках | `#e0a95a` | `bright_yellow` / `cursor` (латунь) |
| Заливка кнопок под белым текстом | `#9a5f22`, hover `#83501c` | латунь темнее: белый на `#c1893e` дает 2.7:1, здесь 5.2:1 |
| Выделение строк | `#3a2418` | `selection` |
| Факт на графиках / связи графа | `#96b4a5` / `#9aafbc` | `bright_cyan` (патина) / `bright_blue` (сталь) |
| Успех / ошибка | `#a7b57a` / `#d65f4c` | `bright_green` / `bright_red` (кармин) |

Все пары проходят те же проверки контраста, что и остальные темы (`apps/web/build/themeTokens.test.ts`: текст 7:1, вторичный 4.5:1, белый на акценте 4.5:1, линии графиков 3:1).

## Как устроено и как добавить еще одну тему

- **CSS** (`packages/ui/src/styles.css`): тема входит в общий темный блок `:root:is([data-theme="dark"], [data-theme="default-dark"], [data-theme="omnissiah"])` и переопределяет свои роли в `:root[data-theme="omnissiah"]`.
- **Темные исключения в разметке** - вариант `dark-theme:` (`apps/web/src/styles.css`, `@custom-variant`), а не `[[data-theme=dark]_&]`: он действует для любой темной темы. Выходные в календаре отпусков - токен `calendar-weekend` вместо жестких цветов.
- **Список тем** - только в контракте `userThemeSchema` (`packages/contracts/src/user-settings.ts`). Миграция **0040** заменила проверку в базе: вместо списка `('default','dark','light')` - формат имени `^[a-z][a-z0-9-]{0,39}$`. Новая тема больше не требует миграции.
- **Новая тема:** имя в `userThemeSchema` и `parseTheme`/`Theme` (`apps/web/src/features/theme/ThemeManager.ts`, цвет панели браузера в `CHROME`), селектор в темных списках (`packages/ui/src/styles.css`, React Flow в `apps/web/src/styles.css`, `dark-theme`), свой блок токенов, пункт и подпись в `ProfileSettingsDialog` и `profile.json`, палитра в циклах `themeTokens.test.ts`.
- Публичная главная (лендинг) и экран до входа по-прежнему светлая/темная по системе: выбранная тема приходит из настроек пользователя после входа.

## Проверки (9 ноября 2026, локально)

- Web: токены и контраст (новый блок Omnissiah), ThemeManager (тема, `color-scheme: dark`, цвет панели `#121010`), профиль, календарь отпусков, отчеты - 82 + 12; полный набор - см. AGENTS.md.
- PostgreSQL: `tests/integration/user-theme.test.ts` - после 0040 `omnissiah` сохраняется, неизвестное имя отклоняет контракт, мусорное имя отклоняет база (`23514`).
- Unit 2535/2535, журнал миграций с 0040.
- Глазами в Chrome 1440×860 на локальном сервере: таблица проекта, Board, календарь отпусков.
