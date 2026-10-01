import "./icon-sizes.css";
/** Humbleicons 1.21.0 — official SVG geometry, MIT © Jiří Zralý.
 * Source: https://github.com/zraly/humbleicons
 * License: ./humbleicons.LICENSE; bundled with desktop runtime notices. */
const icons = {
  // Original brain-and-connections glyph for the work's memory graph.
  "memory": <g stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
    <path d="M12 6a3 3 0 0 0-5.9-.8A4 4 0 0 0 4 12a4 4 0 0 0 2 6.8A3 3 0 0 0 12 19V6Zm0 0a3 3 0 0 1 5.9-.8A4 4 0 0 1 20 12a4 4 0 0 1-2 6.8A3 3 0 0 1 12 19" />
    <path d="M8 8v2l4 2 4-2V8M8 16l4-2 4 2" />
  </g>,
  "login": <g transform="rotate(180 12 12)"><path stroke="currentColor" strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M20 12h-9.5m7.5 3l3-3-3-3m-5-2V6a2 2 0 00-2-2H6a2 2 0 00-2 2v12a2 2 0 002 2h5a2 2 0 002-2v-1"/></g>,
  "logout": <><path stroke="currentColor" strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M20 12h-9.5m7.5 3l3-3-3-3m-5-2V6a2 2 0 00-2-2H6a2 2 0 00-2 2v12a2 2 0 002 2h5a2 2 0 002-2v-1"/></>,
  "search": <><g stroke="currentColor" strokeWidth="2"> <path strokeLinecap="round" d="M20 20L14 14" /> <path d="M15 9.5C15 12.5376 12.5376 15 9.5 15C6.46243 15 4 12.5376 4 9.5C4 6.46243 6.46243 4 9.5 4C12.5376 4 15 6.46243 15 9.5Z" /> </g></>,
  "zoomIn": <><g stroke="currentColor" strokeWidth="2"> <path d="M16 10C16 13.3137 13.3137 16 10 16C6.68629 16 4 13.3137 4 10C4 6.68629 6.68629 4 10 4C13.3137 4 16 6.68629 16 10Z" /> <path strokeLinecap="round" d="M20 20L15 15M7.5 10H10M10 10H12.5M10 10L10 12.5M10 10L10 7.5" /> </g></>,
  "zoomOut": <><g stroke="currentColor" strokeWidth="2"> <path d="M16 10C16 13.3137 13.3137 16 10 16C6.68629 16 4 13.3137 4 10C4 6.68629 6.68629 4 10 4C13.3137 4 16 6.68629 16 10Z" /> <path strokeLinecap="round" d="M20 20L15 15M7.5 10H12.5" /> </g></>,
  // Original closed-book glyph; distinguish projects from chapter documents.
  "novel": <g stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round"><path d="M6 3.5h13v17H6a2.5 2.5 0 0 1-2.5-2.5V6A2.5 2.5 0 0 1 6 3.5Z" /><path d="M7.5 3.5v14M4 18a2.5 2.5 0 0 1 2-1h13M11 7h4" /></g>,
  "book": <><path stroke="currentColor" strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M12 8.618V17.5m0-8.882a1 1 0 00-.553-.894l-.491-.246a7 7 0 00-4.12-.669l-.773.11A8 8 0 014.93 7H4v10h.38a8 8 0 002.197-.308l.553-.158a5 5 0 013.61.336l1.26.63m0-8.882a1 1 0 01.553-.894l.491-.246a7 7 0 014.12-.669l.773.11c.375.054.753.081 1.131.081H20v10h-.38a8 8 0 01-2.197-.308l-.553-.158a5 5 0 00-3.61.336L12 17.5"/></>,
  "outline": <><g stroke="currentColor" strokeLinecap="round" strokeWidth="2"> <path d="M4 6h16" /> <path d="M4 10h13" /> <path d="M4 14h16" /> <path d="M4 18h5.5" /> </g></>,
  "list": <><path stroke="currentColor" strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M4 6h16M4 10h16M4 14h16M4 18h16" /></>,
  "history": <><path stroke="currentColor" strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M12 6.5V12l3.5 2m5.5-2a9 9 0 11-18 0 9 9 0 0118 0z" /></>,
  "edit": <><path stroke="currentColor" strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M13.5 7.5l3 3M4 20v-3.5L15.293 5.207a1 1 0 011.414 0l2.086 2.086a1 1 0 010 1.414L7.5 20H4z"/></>,
  "archive": <><g stroke="currentColor" strokeWidth="2"> <path strokeLinejoin="round" d="M3 5a1 1 0 011-1h16a1 1 0 011 1v3H3V5z" /> <path strokeLinecap="round" d="M9.5 13h5" /> <path strokeLinejoin="round" d="M4 8h16v11a1 1 0 01-1 1H5a1 1 0 01-1-1V8z" /> </g></>,
  "up": <><path stroke="currentColor" strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M5 14l7-7 7 7" /></>,
  "down": <><path stroke="currentColor" strokeLinecap="round" strokeWidth="2" d="M5 10l7 7 7-7" /></>,
  "import": <><path stroke="currentColor" strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M12 11.5V20m0 0l3-3m-3 3l-3-3M8 7.036a3.484 3.484 0 011.975.99M17.5 14c1.519 0 2.5-1.231 2.5-2.75 0-1.265-.854-2.33-2.016-2.65A5 5 0 008.37 7.108a3.5 3.5 0 00-1.87 6.746" /></>,
  "download": <><path stroke="currentColor" strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M12 11.5V20m0 0l3-3m-3 3l-3-3M8 7.036a3.484 3.484 0 011.975.99M17.5 14c1.519 0 2.5-1.231 2.5-2.75 0-1.265-.854-2.33-2.016-2.65A5 5 0 008.37 7.108a3.5 3.5 0 00-1.87 6.746" /></>,
  "info": <><path stroke="currentColor" strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M11 11h1v5.5m0 0h1.5m-1.5 0h-1.5M21 12a9 9 0 1 1-18 0 9 9 0 0 1 18 0Zm-9.5-4v-.5h.5V8h-.5Z"/></>,
  "lock": <><path stroke="currentColor" strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M12 14v2m-4-6V8a4 4 0 118 0v2m-9 9h10a1 1 0 001-1v-7a1 1 0 00-1-1H7a1 1 0 00-1 1v7a1 1 0 001 1z"/></>,
  "unlock": <><path stroke="currentColor" strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M12 15v2m-4-6V7a4 4 0 118 0M7 20h10a1 1 0 001-1v-7a1 1 0 00-1-1H7a1 1 0 00-1 1v7a1 1 0 001 1z"/></>,
  "eye": <><path stroke="currentColor" strokeLinejoin="round" strokeWidth="2" d="M3 12c5.4-8 12.6-8 18 0-5.4 8-12.6 8-18 0z"/> <path stroke="currentColor" strokeLinejoin="round" strokeWidth="2" d="M15 12a3 3 0 11-6 0 3 3 0 016 0z"/></>,
  "more": <><g fill="currentColor"> <rect width="4" height="4" x="3" y="10" rx="2" /> <rect width="4" height="4" x="10" y="10" rx="2" /> <rect width="4" height="4" x="17" y="10" rx="2" /> </g></>,
  "image": <><path stroke="currentColor" strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="m21 17-3.293-3.293a1 1 0 0 0-1.414 0l-.586.586a1 1 0 0 1-1.414 0l-2.879-2.879a2 2 0 0 0-2.828 0L3 17M21 5v14a1 1 0 0 1-1 1H4a1 1 0 0 1-1-1V5a1 1 0 0 1 1-1h16a1 1 0 0 1 1 1Zm-5 3a1 1 0 1 1-2 0 1 1 0 0 1 2 0Z" /></>,
  "chat": <><g fill="currentColor"> <path d="M4 19l-.93-.37a1 1 0 001.125 1.35L4 19zm4.706-.936l.474-.881-.317-.17-.352.07.195.98zm-3.082-3.147l.93.37.163-.414-.196-.399-.897.443zM19 12c0 3.246-2.853 6-6.53 6v2c4.641 0 8.53-3.514 8.53-8h-2zM5.941 12c0-3.246 2.854-6 6.53-6V4C7.83 4 3.94 7.514 3.94 12h2zm6.53-6C16.147 6 19 8.754 19 12h2c0-4.486-3.889-8-8.53-8v2zm0 12c-1.205 0-2.328-.3-3.291-.817l-.948 1.761A8.934 8.934 0 0012.471 20v-2zm-8.276 1.98l4.706-.936-.39-1.961-4.706.936.39 1.962zm2.326-5.506A5.564 5.564 0 015.94 12h-2c0 1.2.282 2.338.786 3.36l1.794-.886zm-1.826.073L3.07 18.631l1.858.738 1.624-4.083-1.858-.739z" /> <circle cx="9" cy="12" r="1" /> <circle cx="12.5" cy="12" r="1" /> <circle cx="16" cy="12" r="1" /> </g></>,
  "sparkles": <><path stroke="currentColor" strokeLinejoin="round" strokeWidth="2" d="M15 19c1.2-3.678 2.526-5.005 6-6-3.474-.995-4.8-2.322-6-6-1.2 3.678-2.526 5.005-6 6 3.474.995 4.8 2.322 6 6Zm-8-9c.6-1.84 1.263-2.503 3-3-1.737-.497-2.4-1.16-3-3-.6 1.84-1.263 2.503-3 3 1.737.497 2.4 1.16 3 3Zm1.5 10c.3-.92.631-1.251 1.5-1.5-.869-.249-1.2-.58-1.5-1.5-.3.92-.631 1.251-1.5 1.5.869.249 1.2.58 1.5 1.5Z" /></>,
  "pause": <><path stroke="currentColor" strokeLinejoin="round" strokeWidth="2" d="M6 6h4v12H6V6ZM14 6h4v12h-4V6Z"/></>,
  "music": <><path stroke="currentColor" strokeLinejoin="round" strokeWidth="2" d="M9 18c0 1.105-1.12 2-2.5 2S4 19.105 4 18s1.12-2 2.5-2 2.5.895 2.5 2zm0 0V7l11-3v11m0 0c0 1.105-1.12 2-2.5 2s-2.5-.895-2.5-2 1.12-2 2.5-2 2.5.895 2.5 2z" /></>,
  "mic": <><path stroke="currentColor" strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M17.5 10.5C17.5 13.5376 15.0376 16 12 16M12 16C8.96243 16 6.5 13.5376 6.5 10.5M12 16V20M8 20H12M12 20H16M12 13C10.6193 13 9.5 11.8807 9.5 10.5V6.5C9.5 5.11929 10.6193 4 12 4C13.3807 4 14.5 5.11929 14.5 6.5V10.5C14.5 11.8807 13.3807 13 12 13Z" /></>,
  "settings": <><path stroke="currentColor" strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M12 4v10m0 6v-.5M17.5 4v5m0 11v-5.56M6.5 4v2m0 14v-8.44M6.5 6a1.5 1.5 0 1 0 0 3 1.5 1.5 0 0 0 0-3Zm5.5 8a1.5 1.5 0 1 0 0 3 1.5 1.5 0 0 0 0-3Zm5.5-5a1.5 1.5 0 1 0 0 3 1.5 1.5 0 0 0 0-3Z"/></>,
  "play": <><path stroke="currentColor" strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M7 17.259V6.741a1 1 0 0 1 1.504-.864l9.015 5.26a1 1 0 0 1 0 1.727l-9.015 5.259A1 1 0 0 1 7 17.259Z"/></>,
  "add": <><g stroke="currentColor" strokeLinecap="round" strokeWidth="2"> <path d="M12 19V5" /> <path d="M19 12H5" /> </g></>,
  "crop": <><path stroke="currentColor" strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M4 7h12a1 1 0 011 1v12M7 10v6a1 1 0 001 1h6M7 4v3m10 10h3"/></>,
  "video": <><g stroke="currentColor" strokeWidth="2"> <path d="M16 16V8a1 1 0 00-1-1H5a1 1 0 00-1 1v8a1 1 0 001 1h10a1 1 0 001-1z" /> <path strokeLinejoin="round" d="M20 7l-4 3v4l4 3V7z" /> </g></>,
  "undo": <><path stroke="currentColor" strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M11 18h3.75a5.25 5.25 0 100-10.5H5M7.5 4L4 7.5 7.5 11" /></>,
  "redo": <><path stroke="currentColor" strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M13 18H9.25a5.25 5.25 0 110-10.5H19M16.5 4L20 7.5 16.5 11"/></>,
  "save": <><path stroke="currentColor" strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M8 4H6a2 2 0 0 0-2 2v12a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V7.828a2 2 0 0 0-.586-1.414l-1.828-1.828A2 2 0 0 0 16.172 4H15M8 4v4a1 1 0 0 0 1 1h5a1 1 0 0 0 1-1V4M8 4h7M7 17v-3a1 1 0 0 1 1-1h8a1 1 0 0 1 1 1v3"/></>,
  "reset": <><path stroke="currentColor" strokeLinecap="round" strokeWidth="2" d="M4 4v5h5M5.07 8a8 8 0 1 1-.818 6" /></>,
  "export": <><path stroke="currentColor" strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M12 10v9m0-9l3 3m-3-3l-3 3m8.5 2c1.519 0 2.5-1.231 2.5-2.75 0-1.264-.854-2.33-2.016-2.65A5 5 0 008.37 8.108a3.5 3.5 0 00-1.87 6.746" /></>,
  "text": <><path stroke="currentColor" strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M12 20V4m7 2V4H5v2m9 14h-4"/></>,
  "track": <><g stroke="currentColor" strokeLinejoin="round" strokeWidth="2"> <path d="M4 8l8-4 8 4-8 4-8-4z" /> <path strokeLinecap="round" d="M4 12l8 4 8-4" /> <path strokeLinecap="round" d="M4 16l8 4 8-4" /> </g></>,
  "close": <><g stroke="currentColor" strokeLinecap="round" strokeWidth="2"> <path d="M6 18L18 6" /> <path d="M18 18L6 6" /> </g></>,
  "delete": <><path stroke="currentColor" strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M6 6l.934 13.071A1 1 0 007.93 20h8.138a1 1 0 00.997-.929L18 6m-6 5v4m8-9H4m4.5 0l.544-1.632A2 2 0 0110.941 3h2.117a2 2 0 011.898 1.368L15.5 6" /></>,
  "left": <><path stroke="currentColor" strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M14 5l-7 7 7 7"/></>,
  "right": <><path stroke="currentColor" strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M10 5l7 7-7 7" /></>,
  "fit": <><path stroke="currentColor" strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M4 8.5V4M4 4H8.5M4 4L9.5 9.5M20 8.5V4M20 4H15.5M20 4L14.5 9.5M4 15.5V20M4 20H8.5M4 20L9.5 14.5M20 15.5V20M20 20H15.5M20 20L14.5 14.5" /></>,
  "focus": <><path stroke="currentColor" strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M4 8V6a2 2 0 0 1 2-2h2m8 0h2a2 2 0 0 1 2 2v2m0 8v2a2 2 0 0 1-2 2h-2m-8 0H6a2 2 0 0 1-2-2v-2"/></>,
  "split": <><path stroke="currentColor" strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M20 6c-3.573 2.225-5.943 3.854-8.55 6M20 18c-2.626-1.636-4.602-2.949-6.5-4.382M8.598 9.54A3 3 0 1 0 5.402 4.46a3 3 0 0 0 3.196 5.08Zm0 0A89.3 89.3 0 0 0 11.45 12m-2.852 2.46a3 3 0 1 0-3.196 5.079 3 3 0 0 0 3.196-5.078Zm0 0A89.287 89.287 0 0 1 11.45 12"/></>,
  "apply": <><path stroke="currentColor" strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M5 14L9 18L19 8" /></>,
  "move": <><path stroke="currentColor" strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M7 9l-3 3m0 0l3 3m-3-3h16m-3 3l3-3m0 0l-3-3" /></>,
  "library": <><path stroke="currentColor" strokeLinejoin="round" strokeWidth="2" d="M17 8V7C17 6.44772 16.5523 6 16 6H10.4142C10.149 6 9.89464 5.89464 9.70711 5.70711L8.29289 4.29289C8.10536 4.10536 7.851 4 7.58579 4H4C3.44772 4 3 4.44772 3 5V17C3 18.1046 3.89543 19 5 19H19C19.5523 19 20 18.5523 20 18V11C20 10.4477 19.5523 10 19 10H8C7.44772 10 7 10.4477 7 11V17C7 18.1046 6.10457 19 5 19V19" /></>,
  "document": <><g stroke="currentColor" strokeLinejoin="round" strokeWidth="2"> <path d="M5 20V4a1 1 0 011-1h6.172a2 2 0 011.414.586l4.828 4.828A2 2 0 0119 9.828V20a1 1 0 01-1 1H6a1 1 0 01-1-1z" /> <path d="M12 3v6a1 1 0 001 1h6" /> </g></>,
  "folder": <><path stroke="currentColor" strokeLinejoin="round" strokeWidth="2" d="M3 18V6a2 2 0 012-2h4.539a2 2 0 011.562.75L12.2 6.126a1 1 0 00.78.375H20a1 1 0 011 1V18a1 1 0 01-1 1H4a1 1 0 01-1-1z" /></>,
  "warning": <><path stroke="currentColor" strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M12 9v4m0 3v.01M5.313 20h13.374c1.505 0 2.471-1.6 1.77-2.931L13.77 4.363c-.75-1.425-2.79-1.425-3.54 0L3.543 17.068C2.842 18.4 3.808 20 5.313 20Z" /></>,
  "sidebar": <><path stroke="currentColor" strokeLinejoin="round" strokeWidth="2" d="M12 4v16m-8 0h16a1 1 0 001-1V5a1 1 0 00-1-1H4a1 1 0 00-1 1v14a1 1 0 001 1z" /></>,
  "model": <><path stroke="currentColor" strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M9 3v3m6-3v3m3 3h3m-3 6h3m-6 3v3m-6-3v3m-3-6H3m3-6H3m6.5 4.5v-3a1 1 0 0 1 1-1h3a1 1 0 0 1 1 1v3a1 1 0 0 1-1 1h-3a1 1 0 0 1-1-1ZM7 18h10a1 1 0 0 0 1-1V7a1 1 0 0 0-1-1H7a1 1 0 0 0-1 1v10a1 1 0 0 0 1 1Z"/></>,
} as const;
export function ActionIcon({name, className = ""}: {name: keyof typeof icons; className?: string}) {
  return <svg className={`jz-video-tool-icon humbleicons ${className}`} width="18" height="18" viewBox="0 0 24 24" fill="none" aria-hidden="true" focusable="false"><g stroke="none">{icons[name]}</g></svg>;
}
