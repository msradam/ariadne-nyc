// Minimal i18n helper. Add a language by extending TRANSLATIONS.
// Usage: t('chat.placeholder') or t('route.mins', { n: 12 })

const TRANSLATIONS = {
  en: {
    'app.title': 'Ariadne. NYC Accessibility Router',
    'chat.placeholder': 'Describe where you want to go or what you need…',
    'chat.send': 'Send message',
    'chat.voice': 'Speak your query',
    'chat.hint':
      'Try: "wheelchair route from Grand Central to Atlantic Terminal" · "find somewhere cool near Flushing" · "what can I reach in 15 minutes from Penn Station"',
    'route.mins': '{{n}} min',
    'route.km': '{{n}} km',
    'route.walk': 'Walk',
    'route.subway': 'Subway',
    'route.arrive': 'Arrive at {{name}}',
    'route.board': 'Board at {{name}}',
    'route.alight': 'Alight at {{name}}',
    'route.summary.heading': 'Route summary',
    'route.walk_only': 'Walk only',
    'route.multimodal': 'Walk + subway',
    'iso.near': '≤ {{n}} min walk',
    'iso.mid': '≤ {{n}} min walk',
    'iso.far': '≤ {{n}} min walk',
    'feed.transit': 'Transit: {{stops}} stops · {{ada}} ADA',
    'feed.elevators_out': ' · {{n}} elevators out',
    'feed.weather': '{{temp}}°F · {{summary}}',
    'feed.code_red': 'Heat advisory',
    'feed.code_blue': 'Cold advisory',
    'controls.isochrone': 'Isochrone',
    'controls.clear': 'Clear',
    'controls.lang': 'Language',
    'privacy.title': 'Privacy log',
    'privacy.empty': 'No network requests yet.',
    'privacy.z2': 'Civic data',
    'privacy.z3': 'Infrastructure',
    'privacy.close': 'Close privacy log',
    'loading.graph': 'Loading pedestrian graph…',
    'loading.transit': 'Transit index waiting…',
    'loading.model': 'Loading AI model (WebGPU)…',
    'loading.ready': 'Ariadne is ready.',
    'error.no_webgpu': 'WebGPU not available. Map + routing work, but chat is disabled. Use Chrome or Edge.',
    'error.router_not_ready': 'Router not ready yet.',
    'error.model_loading': 'Model is still loading. Please wait.',
    'map.label': 'Route map. Use the route summary below for screen-reader navigation.',
    'map.zoom_in': 'Zoom in',
    'map.zoom_out': 'Zoom out',
    'map.recenter': 'Center on New York City',
  },
  es: {
    'app.title': 'Ariadne. Enrutador de accesibilidad de NYC',
    'chat.placeholder': 'Describe a dónde quieres ir o qué necesitas…',
    'chat.send': 'Enviar mensaje',
    'chat.voice': 'Habla tu consulta',
    'chat.hint':
      'Prueba: "silla de ruedas de Grand Central a Atlantic Terminal" · "busca un lugar fresco cerca de Flushing"',
    'route.mins': '{{n}} min',
    'route.km': '{{n}} km',
    'route.walk': 'Caminar',
    'route.subway': 'Metro',
    'route.arrive': 'Llegar a {{name}}',
    'route.board': 'Abordar en {{name}}',
    'route.alight': 'Bajar en {{name}}',
    'route.summary.heading': 'Resumen de ruta',
    'route.walk_only': 'Solo a pie',
    'route.multimodal': 'A pie + metro',
    'iso.near': '≤ {{n}} min a pie',
    'iso.mid': '≤ {{n}} min a pie',
    'iso.far': '≤ {{n}} min a pie',
    'feed.transit': 'Tránsito: {{stops}} paradas · {{ada}} ADA',
    'feed.elevators_out': ' · {{n}} ascensores fuera de servicio',
    'feed.weather': '{{temp}}°F · {{summary}}',
    'feed.code_red': 'Aviso de calor',
    'feed.code_blue': 'Aviso de frío',
    'controls.isochrone': 'Isócrona',
    'controls.clear': 'Limpiar',
    'controls.lang': 'Idioma',
    'privacy.title': 'Registro de privacidad',
    'privacy.empty': 'Aún no hay solicitudes de red.',
    'privacy.z2': 'Datos cívicos',
    'privacy.z3': 'Infraestructura',
    'privacy.close': 'Cerrar registro de privacidad',
    'loading.graph': 'Cargando grafo peatonal…',
    'loading.transit': 'Índice de tránsito en espera…',
    'loading.model': 'Cargando modelo IA (WebGPU)…',
    'loading.ready': 'Ariadne está lista.',
    'error.no_webgpu': 'WebGPU no disponible. El mapa y el enrutamiento funcionan, pero el chat está desactivado.',
    'error.router_not_ready': 'El enrutador aún no está listo.',
    'error.model_loading': 'El modelo aún se está cargando. Por favor espera.',
    'map.label': 'Mapa de ruta. Use el resumen de ruta a continuación para la navegación con lector de pantalla.',
    'map.zoom_in': 'Acercar',
    'map.zoom_out': 'Alejar',
    'map.recenter': 'Centrar en la Ciudad de Nueva York',
  },
} as const;

type LangCode = keyof typeof TRANSLATIONS;
type Keys = keyof (typeof TRANSLATIONS)['en'];

let currentLang: LangCode = 'en';

export function setLang(lang: LangCode) {
  currentLang = lang;
}

export function getLang(): LangCode {
  return currentLang;
}

export function t(key: Keys, params?: Record<string, string | number>): string {
  const dict = (TRANSLATIONS[currentLang] ?? TRANSLATIONS['en']) as Record<string, string>;
  let str = dict[key] ?? (TRANSLATIONS['en'] as Record<string, string>)[key] ?? key;
  if (params) {
    for (const [k, v] of Object.entries(params)) {
      str = str.replaceAll(`{{${k}}}`, String(v));
    }
  }
  return str;
}
