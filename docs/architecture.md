# Diagram Arsitektur (Mermaid)

GitHub dan GitLab menampilkan blok di bawah ini sebagai gambar secara otomatis.

**Untuk melihatnya di https://mermaid.live:** buka salah satu file di folder `diagrams/` (`*.mmd`), salin **seluruh isinya**, lalu tempel. Jangan menempel file ini, karena berisi teks lain dan lebih dari satu diagram.

*Catatan: nama tabel, nama kolom, endpoint, dan istilah teknis sengaja dibiarkan dalam bahasa Inggris karena sama persis dengan yang ada di kode.*

## 1. Arsitektur end-to-end dan autentikasi di setiap hop

```mermaid
flowchart LR
  subgraph ONPREM["On-premise hotel"]
    BE["Booking Engine"] --> OPERA["Opera PMS"]
    SIM["Simphony POS"] --> OPERA
    CAM["Kamera IoT - penghitung orang"]
    subgraph EDGE["Server Edge Ubuntu dengan systemd"]
      EMW["Edge Middleware<br/>POST /webhook/opera<br/>outbox SQLite dan retry"]
      EIOT["Edge Middleware IoT<br/>POST /api/v1/iot/people-count<br/>buffer SQLite, kirim tiap 60 detik"]
    end
  end

  subgraph CLOUD["Cloud"]
    NS["NetSuite ERP"]
    subgraph GCP["Google Cloud"]
      GMW["GCP Middleware<br/>Cloud Run, POST /graphql<br/>DataLoader"]
      SM["Secret Manager<br/>kredensial OAuth NetSuite"]
      BQ[("BigQuery<br/>star schema")]
    end
  end

  BI["Dashboard BI"]

  OPERA -->|"Bearer Token"| EMW
  EMW -->|"HMAC-SHA256 + Idempotency-Key"| NS
  NS -->|"OAuth 2.0"| GMW
  GMW -.->|"baca secret via ADC"| SM
  GMW -->|"OIDC via ADC, tanpa JSON key"| BQ
  CAM -->|"API Key"| EIOT
  EIOT -->|"Workload Identity Federation"| BQ
  BI -->|"GraphQL dengan ID token"| GMW
```

## 2. Module 1: webhook, proses async, dan idempotency

```mermaid
sequenceDiagram
  autonumber
  participant O as Opera PMS
  participant W as Webhook Express
  participant Q as Outbox SQLite
  participant K as Worker tiap 2 detik
  participant N as NetSuite

  O->>W: POST /webhook/opera dengan Bearer token
  alt token tidak ada atau salah
    W-->>O: 401 atau 403
  else token valid
    W->>Q: INSERT OR IGNORE idempotency_key dan payload
    W-->>O: 202 Accepted, duplicate true atau false
  end

  loop proses di background
    K->>Q: ambil baris pending yang sudah waktunya
    K->>K: tanda tangan HMAC-SHA256 atas timestamp.nonce.body
    K->>N: POST dengan X-Signature dan Idempotency-Key
    alt 2xx
      N-->>K: OK
      K->>Q: status sent
    else timeout, 5xx atau 429
      K->>Q: attempts ditambah 1, exponential backoff
    else 4xx lainnya atau batas percobaan habis
      K->>Q: status dead, ditinjau manual
    end
  end
```

## 3. Module 3: request GraphQL dengan batching DataLoader

```mermaid
flowchart TD
  REQ["BI mengirim POST /graphql<br/>transactions beserta location dan visitors"] --> CTX["Buat DataLoader baru untuk request ini"]
  CTX --> TX["Resolver transactions<br/>ambil N baris dari NetSuite"]
  TX --> F1["Field resolver memanggil<br/>location.load id, sebanyak N kali"]
  TX --> F2["Field resolver memanggil<br/>visitors.load lokasi dan tanggal, sebanyak N kali"]
  F1 --> B1["Kumpulkan dan buang kunci kembar"]
  F2 --> B2["Kumpulkan dan buang kunci kembar"]
  B1 --> Q1[("1 query ke dim_location<br/>WHERE id IN UNNEST")]
  B2 --> Q2[("1 query ke fact_iot_camera_events<br/>GROUP BY lokasi dan tanggal")]
  Q1 --> RES["Gabungkan hasil sesuai urutan kunci"]
  Q2 --> RES
  RES --> OUT["Respons JSON"]
```

## 4. Module 4: star schema

```mermaid
erDiagram
  dim_location ||--o{ fact_transactions : memiliki
  dim_location ||--o{ fact_iot_camera_events : memiliki
  dim_date ||--o{ fact_transactions : pada_tanggal
  dim_date ||--o{ fact_iot_camera_events : pada_tanggal

  dim_location {
    STRING location_id PK
    STRING location_name
    STRING area
  }
  dim_date {
    DATE date_key PK
    INT64 cal_year
    INT64 cal_month
    BOOL is_weekend
  }
  fact_transactions {
    STRING transaction_id
    TIMESTAMP transaction_ts
    DATE transaction_date FK
    STRING location_id FK
    NUMERIC amount
  }
  fact_iot_camera_events {
    STRING event_id
    TIMESTAMP event_ts
    DATE event_date FK
    STRING location_id FK
    INT64 in_count
  }
```
