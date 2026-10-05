# FirmaLocal: rellena y firma PDF sin subirlos

Extensión para Chrome y Edge. Abre un PDF, rellena sus campos, añade texto, fecha, marcas y tu firma, y descarga el resultado. **Todo ocurre en el ordenador del usuario: el PDF nunca se envía a ningún servidor.**

Versión 0.1.0: primera versión mínima para validar la demanda.

## Qué hace

- **Abrir PDF:** botón, arrastrar y soltar, clic en el icono estando en un PDF, o clic derecho sobre un enlace a un PDF ("Rellenar y firmar con FirmaLocal").
- **Rellenar formularios:** detecta los campos del PDF (texto, varias líneas, casillas, opciones, desplegables).
- **Añadir encima del documento:** texto, fecha de hoy, marca ✓ y cruz ✗, que se pueden mover, cambiar de tamaño y borrar.
- **Firma:** dibujada con ratón o dedo, escrita con letra manuscrita, o una foto de la firma (quita el fondo blanco automáticamente). Se puede guardar en el ordenador para la próxima vez.
- **Descargar:** genera `nombre-firmado.pdf`. Por defecto "bloquea" el formulario (convierte los campos en texto fijo); se puede desactivar.
- Páginas giradas, zoom, modo oscuro y atajos de teclado: T texto, F firma, D fecha, Supr borrar, Esc cancelar.

## Probado

Pruebas automáticas en Chromium (`dev/test-e2e.mjs`) con un formulario de prueba: texto, DNI, desplegable, opciones, casilla, campo de varias líneas, texto libre, fecha, marca, firma dibujada, firma guardada y página girada 90°. Los valores se comprueban leyendo el PDF resultante.

También se ha probado con formularios oficiales reales (`dev/test-real-pdf.mjs`):
- **Modelo 145 de la Agencia Tributaria:** 120 campos.
- **W-9 del IRS** (EE. UU.): 23 campos.

## Probarlo en tu navegador (5 minutos)

1. Descomprime `firmalocal-0.1.0.zip` en una carpeta.
2. **Chrome:** ve a `chrome://extensions`, activa **Modo de desarrollador** (arriba a la derecha), pulsa **Cargar descomprimida** y elige la carpeta.
   **Edge:** ve a `edge://extensions`, activa **Modo de desarrollador**, pulsa **Cargar desempaquetada** y elige la carpeta.
3. Fija el icono de FirmaLocal en la barra y púlsalo.

## Publicarlo

| | Chrome Web Store | Edge Add-ons |
|---|---|---|
| Alta de desarrollador | https://chrome.google.com/webstore/devconsole (pago único de 5 $) | https://partner.microsoft.com/dashboard/microsoftedge (gratis) |
| Qué subir | `firmalocal-0.1.0.zip` | El mismo zip |
| Revisión | Normalmente de unos días | Normalmente de unos días |

Para la ficha de la tienda necesitarás:
- **Textos:** están en `TIENDA.md`.
- **Política de privacidad publicada en una URL:** el texto está en `PRIVACIDAD.md`. Se puede publicar gratis, por ejemplo, en GitHub Pages o en tu web.
- **Capturas de 1280×800:** se pueden sacar de la propia extensión.
- **Justificación de permisos:**
  - `storage`: guarda la firma solo en el ordenador.
  - `contextMenus`: añade la opción de clic derecho sobre enlaces a PDF.
  - Acceso a webs: es opcional y solo se pide si el usuario abre un PDF desde una web.

## Limitaciones conocidas (para próximas versiones)

- Los **PDF protegidos con contraseña o cifrados** se rechazan con un aviso. Algunos formularios oficiales vienen así.
- El texto añadido usa Helvetica. Caracteres fuera del alfabeto latino se sustituyen por "?".
- No hay deshacer (Ctrl+Z). Los elementos se borran con su botón ✕ o con Supr.
- Formularios XFA (formato antiguo de Adobe): se muestra la versión estándar si el PDF la incluye.
- Abrir un PDF desde una web pide permiso para esa web. Este flujo no está cubierto por las pruebas automáticas.

## Próximos pasos propuestos

1. **Pro con ExtensionPay** (5 % por venta más Stripe): perfiles de autorrelleno (nombre, DNI, dirección), varias firmas guardadas, plantillas y unir/dividir PDF.
2. Deshacer, buscar campos y fuentes con más caracteres.
3. Fase 2: "Enviar a firmar" y plugin de Claude (ver la propuesta de producto).

## Estructura

```
extension/          Lo que se publica en las tiendas
  manifest.json     Manifest V3 (Chrome y Edge)
  background.js     Icono y menú contextual
  editor.html/.css/.js  El editor
  vendor/           pdf.js (Apache-2.0) y pdf-lib (MIT), sin cambios
  icons/
dev/                Pruebas y utilidades (no se publica)
```

Para ejecutar las pruebas: `cd dev && npm install && node make-sample.mjs && node test-e2e.mjs`.
