# Workloom: адреса сайта, приложения и подготовка Auth

**Статус: локальное разделение landing/app принято на `9e13b63`; Auth остаётся планом.** Product commit `9e13b63b943498a80c5ff2d4029027837c8a9e1e` содержит 21 файл; локальные build/HTTP/Chrome/изолированные PostgreSQL gates прошли. Общий Auth, настоящий Google login, публичный выпуск и production-окружение этим не реализованы и не проверены. Конфигурация Workloom по-прежнему допускает только `APP_ENV=local`, `AUTH_MODE=dev`, loopback и синтетическую базу; Railway markers и `AUTH_MODE=shared` отклоняются ([config](../apps/api/src/config.ts)). Исторический UX evidence остаётся в [71](71-night-verification.md); ниже записаны только новые gates маршрутизации.

## Два адреса и место приложения

| Назначение | Production после отдельного выпуска | Локальная собранная версия |
| --- | --- | --- |
| Landing | `https://workloom.pavelignatov.com/` | `http://127.0.0.1:4310/` |
| Приложение | `https://workloom.pavelignatov.com/app` | `http://127.0.0.1:4310/app` |
| Будущий browser Auth callback | `https://workloom.pavelignatov.com/app/auth/callback` | `http://127.0.0.1:4310/app/auth/callback` |

Production использует обычный HTTPS без публичного `:4310`. Порт 4310 — локальная собранная версия или внутренний порт будущего сервиса. `4311` остаётся вторичным Vite development origin; его не регистрируем для Auth без отдельной необходимой allowlist entry. Для проверки итогового compiled UI используем **4310**, а не 4311.

Корень предназначен для заранее отрендеренного landing из English JSON-каталога: canonical **`https://workloom.pavelignatov.com/`**, sitemap и индексируемый HTML. Сборка выдаёт `landing.html`, SPA `index.html` с **noindex**, `robots.txt` и `sitemap.xml`. `/app` — namespace приложения, не поисковая посадочная страница. `/api`, health и hashed assets сохраняют собственное обслуживание; SPA fallback не должен превращать API/asset 404 в HTML. Старые `/w/...` маршруты переводятся под `/app`, сохраняя query и fragment. Это подтверждено локальными compiled browser/HTTP gates ниже; наличие canonical production host не означает, что домен уже опубликован.

## Что понадобится для login

По проверке исходников Auth координатором, browser login **не требует `client_secret`, service key или выдачи нового серверного секрета**. Проверка токенов использует **RS256/JWKS**, issuer **`https://auth.pavelignatov.com`**, audience **`pet-projects`**. Service registration из следующего раздела относится к analytics, а не к разрешению войти.

Для будущего включения Workloom добавить в разрешённые browser callbacks именно эти две записи:

```text
https://workloom.pavelignatov.com/app/auth/callback
http://127.0.0.1:4310/app/auth/callback
```

Оператор добавляет эти строки в **существующий `ALLOWED_REDIRECT_URIS` Auth**, сохраняя entries других продуктов. Auth читает конфигурацию при старте, поэтому изменение вступает в силу после обычного разрешённого restart/redeploy Auth. В этом шаге allowlist не менялась.

В browser SDK **`appUrl` задаётся явно тем же полным callback URL** соответствующего окружения: production использует HTTPS-строку выше, локальная сборка — строку с `127.0.0.1:4310`. Не полагаться на вычисление appUrl из текущего landing URL и не заменять его `/`, `/app` или 4311.

Это рекомендуемые точные значения настройки, **не утверждение об exact-path enforcement Auth**. Текущий `isAllowedRedirect` в Auth (`src/http/redirectAllowlist.ts`, строки 24–29) сравнивает нормализованный origin и затем raw pathname prefix. CORS origins выводятся из разрешённых origins. Поэтому нельзя описывать allowlist как строгое сравнение полного callback path или считать настройку callback отдельным доказательством безопасной Workloom session. Здесь приведены результаты source review; чужой Auth repository в этом шаге не меняется.

## План совместимого browser → BFF flow

Нынешний Auth возвращает результат во **fragment браузерного callback**, а не через OAuth authorization-code exchange. Будущий Workloom flow должен сначала обработать fragment на callback, до обычной app-навигации, затем убрать его из адреса и передать результат **same-origin POST** в собственный BFF. Нельзя выдавать это за уже реализованный code/token endpoint или заменять протокол придуманным `client_secret`.

BFF должен проверить подпись/issuer/audience и необходимые claims, связать Auth `sub` с Workloom user/membership без подмены синтетического actor и создать собственную **HttpOnly session**. Refresh остаётся серверным и сериализуется на session, чтобы параллельные запросы не соревновались за refresh token. Hand-off и дальнейшие изменения требуют CSRF/source-origin защиты; возвращаемая навигация не должна открывать произвольный redirect. Workspace isolation, текущие роли/членство и отзыв доступа продолжают проверяться серверными командами. Browser JS не получает private service key или собственный session/refresh secret для ручной вставки.

Это **план следующего Auth-среза**, а не функциональность нынешнего Workloom. До его реализации/проверки нельзя открывать synthetic dev identity публике, отключать запрет Railway или считать landing доказательством работающего входа. План эксплуатации и отдельного разрешённого выпуска — [08](08-railway-and-operations.md); общий/shared scope пилота и условные private ACL — [74](74-next-team-pilot.md).

## Необязательный analytics service key: команда один раз

Если для Workloom отдельно включается first-party analytics, оператор Auth может **однократно** выполнить следующую команду **из корня production release Auth**, где production environment уже безопасно инжектирован:

```sh
node dist/scripts/register-service.js workloom "Workloom" 'https://workloom.pavelignatov.com,http://127.0.0.1:4310'
```

Команда регистрирует service ID `workloom`, label `Workloom` и два **origins**, не callback paths. Она один раз печатает **`pk` / browser key** и **`sk` / server key**. Повтор с существующим ID отклоняется: это не upsert, не восстановление прежнего секрета и не rotation. Не запускать её повторно ради повторного вывода ключа. Нужный operational recovery/rotation — отдельное действие в Auth.

`sk` нужен только в серверном environment при включённой analytics-интеграции; в landing, SPA, JSON, URL и логи его не добавляют. `pk` — browser identifier analytics и не login secret. Для login сама эта команда не нужна и redirect allowlist не заменяет: DB registry analytics и redirect configuration независимы; регистрация не редактирует allowlist и не требует restart collector. Не присылайте в чат private key, session или refresh token; подтверждения выполнения без их значений достаточно.

**В этом шаге команда не выполняется:** Auth configuration, DNS, hosting, deploy и платные ресурсы не меняются. Наличие операторской инструкции не означает, что service или callbacks уже зарегистрированы.

## Проверено локально — `9e13b63`

Авторские focused gates: web **58 tests / 7 suites / 17.79s**, API/static **29 / 1.93s**. Root global check прошёл **08:58:23.697 → 08:59:18.978 UTC**, полный build **08:59:18.981 → 08:59:46.384 UTC**, оба exit **0**: `/private/tmp/workloom-hosting-build-proof.json`, `/private/tmp/workloom-hosting-check.log`, `/private/tmp/workloom-hosting-build.log`. Compiled entry **`/assets/app-DTmpv0na.js`**, SHA256 **`0d1b82c4437c5d9bfcb2b7bce8d324766d46233bb431fd986ed784b897e2cad7`**; финальная проверка всех **948 non-Markdown tracked/untracked source files** обнаружила **zero changes** (`/private/tmp/workloom-hosting-final-source-proof.json`, **09:01:50.407 UTC**). Это scoped проверки нового шага, не повтор всей исторической night-native матрицы.

Root HTTP прошёл **23/23 checks** (`/private/tmp/workloom-hosting-http-proof.json`): prerendered root/canonical, `/app` noindex, root-only sitemap и robots, legacy redirect, HEAD, корректные неизвестные HTML/API/health/asset 404. Chrome прошёл **30 assertions** (`test-results/hosting-app-prefix/evidence.json`): landing на **4310 и development 4311**, каждый при **1440/390/320**, без landing API requests и page overflow; CTA открывает app workspace. Compiled **4310** поддерживает прямую `/app`-таблицу и reload с **23 rows × 41px** на desktop/mobile; legacy `/w/...` → `/app/w/...` Timeline сохраняет query/fragment и 23 строки. Во всём gate — **zero API writes / JS errors / bad HTTP**. Root визуально проверил desktop/mobile landing. Проверка dev landing не регистрирует 4311 в Auth.

Отдельный compiled SPA-serving gate с настоящим изолированным PostgreSQL прошёл **10/10 за 2.82s** (`/private/tmp/workloom-hosting-private-pg.log`, `/private/tmp/workloom-hosting-private-pg-proof.json`). Список баз до/после одинаков, отдельный private cluster **60651** остановлен; основная база не затронута. Два setup RED сохранены отдельно: `/private/tmp/workloom-hosting-private-pg-initial-bind-guard-red.{json,log}` отказал **до запуска**, потому что старый private config содержал default 5432/localhost при CLI override; исправлена явная привязка `-p 60651 -h 127.0.0.1` и socket. `/private/tmp/workloom-hosting-private-pg-default-role-red.{json,log}` затем упал на несуществующей default role `pavelignatov`; cluster остановили и использовали установленную QA role. Product source не менялся; последующий GREEN не переименовывает эти неудачные попытки.

API-only restart прошёл **09:00:06.106 → 09:00:12.567 UTC** (`/private/tmp/workloom-hosting-api-restart-proof.json`): API **88227 → 41985**, PostgreSQL **46630** и Vite **46683** сохранены, worker **OFF**. Снимок **73 total / 60 public tables / 37,949 public rows**, data SHA256 **`d695234f107927a7bab6e8497853374c5cc944f6bbdf60d0520108862c982a81`** и catalog SHA256 **`36cc073a04760ff7acc19b9fc70c00d4e9732407c51e2299e5994d116ea1bc37`** совпали до/после. Проверены реальные bytes/MIME **17 JS/CSS/HTML resources**, readiness body и doctor. После всех Chrome/private-PG gates дополнительно прошёл read-only `/private/tmp/workloom-hosting-final-preservation-proof.json`: те же data/catalog, 73/60 tables и 37,949 public rows, все 17 served-resource bytes/MIME и main process identities сохранены, worker OFF. Это отдельная финальная conservation-проверка; API-only restart выше не является restart PostgreSQL/Vite, OS reboot или release.

GREEN означает **локальное разделение сайта/приложения**. Callback route, SDK/BFF и настоящий Auth flow пока не реализованы. Для них отдельно потребуются callback/fragment hand-off, session/refresh, CSRF, sub mapping, роли/выход/отзыв доступа и browser end-to-end. Google login, public DNS/HTTPS, deployment и hosted production этим шагом **не проверены**. Две callback-строки выше — подготовленная настройка; optional analytics CLI не выполнялась, ключи не выпускались.
