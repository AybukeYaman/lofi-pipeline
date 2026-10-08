import { useEffect, useState } from 'react';
import { ApiError } from './api';

export type ToastType = 'error' | 'success' | 'warning' | 'info';

export type ParsedError = {
  status?: number;
  statusText?: string;
  title: string;
  message: string;
  explanation: string;
  problems?: string[];
  missing?: string[];
  raw?: unknown;
};

export type ToastItem = {
  id: string;
  type: ToastType;
  title: string;
  message: string;
  status?: number;
  statusText?: string;
  explanation?: string;
  problems?: string[];
  duration?: number;
  createdAt: number;
};

const STATUS_MAP: Record<number, { title: string; explanation: string }> = {
  400: {
    title: 'Geçersiz İstek (400 Bad Request)',
    explanation: 'Gönderilen verilerde eksik veya uyumsuz parametreler tespit edildi.',
  },
  401: {
    title: 'Yetkilendirme Gerekli (401 Unauthorized)',
    explanation: 'Bu işlem için oturum açmanız veya yetkili bir anahtar sağlamanız gerekiyor.',
  },
  403: {
    title: 'Erişim Reddedildi (403 Forbidden)',
    explanation: 'Bu kaynağa veya işleme erişim yetkiniz bulunmuyor (ör. geçersiz host veya yetkisiz erişim).',
  },
  404: {
    title: 'Kaynak Bulunamadı (404 Not Found)',
    explanation: 'İstediğiniz proje, stil, parça veya dosya sistemde mevcut değil.',
  },
  409: {
    title: 'Çakışma / Zaten Mevcut (409 Conflict)',
    explanation: 'Bu isimde bir kayıt zaten var veya arka planda benzer bir işlem şu an çalışıyor.',
  },
  413: {
    title: 'Yükleme Çok Büyük (413 Payload Too Large)',
    explanation: 'Yüklenen görsel veya video boyutu sunucu sınırını aştı (maksimum görsel limiti 25 MB).',
  },
  415: {
    title: 'Desteklenmeyen Biçim (415 Unsupported Media)',
    explanation: 'İstek gövdesi JSON formatında değil veya desteklenmeyen bir dosya uzantısı kullanıldı.',
  },
  422: {
    title: 'Doğrulama Hatası (422 Unprocessable Entity)',
    explanation: 'Veriler gönderildi ancak sistem doğrulama kurallarını karşılamadı.',
  },
  429: {
    title: 'İstek Limiti / Kota Aşımı (429 Too Many Requests)',
    explanation: 'Gemini veya API kota sınırı aşıldı. Lütfen biraz bekleyip tekrar deneyin.',
  },
  500: {
    title: 'Sunucu Hatası (500 Internal Server Error)',
    explanation: 'Arka uç sunucusunda beklenmeyen bir sistem hatası meydana geldi.',
  },
  502: {
    title: 'Üst Servis Hatası (502 Bad Gateway)',
    explanation: 'Gemini veya harici yapay zeka servisi yanıt veremedi veya geçersiz yanıt döndürdü.',
  },
  503: {
    title: 'Servis Kullanılamıyor (503 Service Unavailable)',
    explanation: 'GEMINI_API_KEY tanımlanmamış veya harici servis şu anda ulaşılamaz durumda.',
  },
};

/**
 * Parses any arbitrary error (ApiError, Error, TypeError, string, etc.) into a rich structured ParsedError.
 */
export function parseAppError(error: unknown, fallbackMessage = 'Beklenmeyen bir hata oluştu.'): ParsedError {
  if (error instanceof ApiError) {
    const info = STATUS_MAP[error.status] || {
      title: `Sunucu Yanıtı (${error.status})`,
      explanation: 'Sunucu işlem sırasında bir hata döndürdü.',
    };

    let userMessage = error.message;
    if (userMessage === 'Failed to fetch' || userMessage === 'FetchError') {
      userMessage = 'Sunucuya ulaşılamadı. Web sunucusunun çalıştığından emin olun.';
    }

    return {
      status: error.status,
      statusText: info.title,
      title: info.title,
      message: userMessage || fallbackMessage,
      explanation: info.explanation,
      problems: error.problems,
      missing: error.missing,
      raw: error,
    };
  }

  if (error instanceof Error) {
    const isNetworkError =
      error.message.includes('Failed to fetch') ||
      error.message.includes('NetworkError') ||
      error.message.includes('ECONNREFUSED');

    if (isNetworkError) {
      return {
        status: 0,
        statusText: 'Bağlantı Hatası (Network Error)',
        title: 'Bağlantı Hatası (Network Error)',
        message: 'Sunucuya bağlanılamadı. `npm run web` sunucusunun açık olduğundan veya dosya boyutunun aşılmadığından emin olun.',
        explanation: 'Tarayıcı sunucudan yanıt alamadı veya bağlantı sonlandırıldı.',
        raw: error,
      };
    }

    return {
      title: 'Uygulama Hatası',
      message: error.message || fallbackMessage,
      explanation: 'İşlem yürütülürken istemci tarafında bir hata oluştu.',
      raw: error,
    };
  }

  if (typeof error === 'string') {
    return {
      title: 'Hata Bildirimi',
      message: error,
      explanation: 'Sistem bir uyarı mesajı verdi.',
      raw: error,
    };
  }

  return {
    title: 'Hata',
    message: fallbackMessage,
    explanation: 'Bilinmeyen bir hata oluştu.',
    raw: error,
  };
}

type ToastListener = (toast: ToastItem) => void;
const listeners = new Set<ToastListener>();

export function showToast(options: {
  type: ToastType;
  title?: string;
  message: string;
  status?: number;
  statusText?: string;
  explanation?: string;
  problems?: string[];
  duration?: number;
}) {
  const id = `toast-${Date.now()}-${Math.random().toString(36).substring(2, 7)}`;
  const item: ToastItem = {
    id,
    type: options.type,
    title: options.title || (options.type === 'error' ? 'Hata' : options.type === 'success' ? 'Başarılı' : 'Bilgi'),
    message: options.message,
    status: options.status,
    statusText: options.statusText,
    explanation: options.explanation,
    problems: options.problems,
    duration: options.duration ?? (options.type === 'error' ? 8000 : 4500),
    createdAt: Date.now(),
  };

  for (const listener of listeners) {
    listener(item);
  }
  return id;
}

export function showError(error: unknown, fallbackMessage?: string) {
  const parsed = parseAppError(error, fallbackMessage);
  return showToast({
    type: 'error',
    title: parsed.title,
    message: parsed.message,
    status: parsed.status,
    statusText: parsed.statusText,
    explanation: parsed.explanation,
    problems: parsed.problems,
    duration: 9000,
  });
}

export function showSuccess(message: string, title = 'Başarılı') {
  return showToast({ type: 'success', title, message, duration: 4000 });
}

export function showWarning(message: string, title = 'Uyarı') {
  return showToast({ type: 'warning', title, message, duration: 6000 });
}

export function showInfo(message: string, title = 'Bilgi') {
  return showToast({ type: 'info', title, message, duration: 4500 });
}

/**
 * Toast Container UI rendered once at root level.
 */
export function ToastContainer() {
  const [toasts, setToasts] = useState<ToastItem[]>([]);

  useEffect(() => {
    const handleNewToast = (item: ToastItem) => {
      setToasts((prev) => [...prev, item]);
    };
    listeners.add(handleNewToast);
    return () => {
      listeners.delete(handleNewToast);
    };
  }, []);

  const removeToast = (id: string) => {
    setToasts((prev) => prev.filter((t) => t.id !== id));
  };

  if (toasts.length === 0) return null;

  return (
    <div className="toast-container" aria-live="polite" aria-atomic="true">
      {toasts.map((toast) => (
        <ToastCard key={toast.id} item={toast} onDismiss={() => removeToast(toast.id)} />
      ))}
    </div>
  );
}

function ToastCard({ item, onDismiss }: { item: ToastItem; onDismiss: () => void }) {
  const [expanded, setExpanded] = useState(false);

  useEffect(() => {
    if (item.duration && item.duration > 0) {
      const timer = setTimeout(onDismiss, item.duration);
      return () => clearTimeout(timer);
    }
  }, [item.duration, onDismiss]);

  const typeIcons: Record<ToastType, string> = {
    error: '⚠️',
    success: '✓',
    warning: '⚡',
    info: 'ℹ️',
  };

  return (
    <div className={`toast-card toast-${item.type}`} role="alert">
      <div className="toast-header">
        <span className="toast-icon">{typeIcons[item.type]}</span>
        <div className="toast-title-group">
          <strong>{item.title}</strong>
          {item.status ? (
            <span className="toast-status-badge">HTTP {item.status}</span>
          ) : null}
        </div>
        <button
          type="button"
          className="toast-close"
          onClick={onDismiss}
          aria-label="Kapat"
        >
          ×
        </button>
      </div>

      <div className="toast-body">
        <p className="toast-message">{item.message}</p>

        {item.explanation && item.type === 'error' ? (
          <p className="toast-explanation">{item.explanation}</p>
        ) : null}

        {item.problems && item.problems.length > 0 ? (
          <div className="toast-problems">
            <button
              type="button"
              className="toast-toggle-btn"
              onClick={() => setExpanded(!expanded)}
            >
              {expanded ? '▲ Detayları Gizle' : `▼ ${item.problems.length} Problem Detayı`}
            </button>
            {expanded ? (
              <ul className="toast-problems-list">
                {item.problems.map((p, idx) => (
                  <li key={idx}>{p}</li>
                ))}
              </ul>
            ) : null}
          </div>
        ) : null}
      </div>

      {item.duration ? (
        <div
          className="toast-progress-bar"
          style={{ animationDuration: `${item.duration}ms` }}
        />
      ) : null}
    </div>
  );
}
