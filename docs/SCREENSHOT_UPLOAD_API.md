# Screenshot upload API

Featured App can upload screenshots to **your own HTTP endpoint** (Screenshots →
Uploading → "Your own API"). This is the contract that endpoint must follow.

## Settings

| Setting                | Default     | Meaning                                                              |
| ---------------------- | ----------- | -------------------------------------------------------------------- |
| Upload URL             | —           | `https://…` (or `http://` for a local test server)                    |
| Method                 | `POST`      | `POST` or `PUT`                                                       |
| Body format            | `multipart` | `multipart/form-data` or `application/json`                           |
| Image field name       | `file`      | Form field / JSON key that carries the image                          |
| Headers                | none        | Sent as-is, e.g. `Authorization: Bearer <token>`. Stored encrypted.  |
| Link in the response   | `url`       | Dot path to the link in the JSON answer: `url`, `data.link`, `files.0.url` |

## Request

### multipart/form-data (default)

```
POST /upload HTTP/1.1
Content-Type: multipart/form-data; boundary=…
Accept: application/json
Authorization: Bearer <your token>          ← whatever headers you configured

Fields:
  file          the image (filename "Screenshot 2026-11-20 at 12.14.33.png",
                Content-Type image/png or image/jpeg)
  fileName      "Screenshot 2026-11-20 at 12.14.33.png"
  mimeType      "image/png"
  width         "1920"                         ← pixels, as text (form fields are strings)
  height        "1080"
  capturedAt    "2026-11-20T06:44:33.000Z"     ← ISO 8601, UTC
  source        "featured-app"
```

### application/json

```
POST /upload HTTP/1.1
Content-Type: application/json
Accept: application/json

{
  "file": "iVBORw0KGgoAAAANSUhEUgAA…",          ← base64 of the image bytes (key = image field name)
  "fileName": "Screenshot 2026-11-20 at 12.14.33.png",
  "mimeType": "image/png",
  "width": 1920,
  "height": 1080,
  "capturedAt": "2026-11-20T06:44:33.000Z",
  "source": "featured-app"
}
```

The image is PNG unless Screenshots → General → Save format picks JPEG. With
"Downscale to 1×" on, Retina captures are sent at half size.

## Response

Any **2xx** status, with **either**

```json
{ "url": "https://files.example.com/abc123.png" }
```

(the link found at the configured path — e.g. path `data.link` reads
`{ "data": { "link": "https://…" } }`), **or** a plain-text body that is only the
link:

```
https://files.example.com/abc123.png
```

The link must be `http(s)://`. Featured App copies it to the clipboard (if
"Copy the link" is on) and shows it in the editor's status bar.

Any other status — or a 2xx without a link — is shown to the user as an error
with the first 200 characters of the body, so return a readable message:

```json
HTTP/1.1 401 Unauthorized
{ "error": "Token expired" }
```

Requests time out after 2 minutes.

## "Test connection"

The Test connection button sends a real upload of a 1×1 transparent PNG named
`featured-app-test.png`. Your endpoint may delete it, or recognise it by that
name.

## Example server (Node.js + Express + multer)

```js
import express from 'express'
import multer from 'multer'
import { randomUUID } from 'node:crypto'
import { extname } from 'node:path'

const app = express()
const upload = multer({
  storage: multer.diskStorage({
    destination: 'uploads/',
    filename: (_req, file, cb) => cb(null, randomUUID() + extname(file.originalname))
  }),
  limits: { fileSize: 25 * 1024 * 1024 }
})

app.use('/files', express.static('uploads'))

app.post('/upload', upload.single('file'), (req, res) => {
  if (req.get('authorization') !== `Bearer ${process.env.UPLOAD_TOKEN}`) {
    return res.status(401).json({ error: 'Bad token' })
  }
  if (!req.file) return res.status(400).json({ error: 'No file' })
  res.json({ url: `https://files.example.com/files/${req.file.filename}` })
})

app.listen(3000)
```

## Other upload services

- **S3 / Cloudflare R2 / Backblaze B2 / MinIO** — requests are signed with AWS
  Signature V4 in the app; the key only needs `PutObject` (and optionally
  `DeleteObject` for Test connection). Link sharing: a public base URL, a
  presigned link (up to 7 days), or none.
- **Google Drive** — needs a Google Cloud OAuth client of type *Desktop app*
  (steps on the Uploading tab). Only the `drive.file` scope is requested, so the
  app can see only the files it uploaded. The refresh token is stored encrypted
  with the OS keychain (`screenshot-secrets.json` in the app's data folder).
