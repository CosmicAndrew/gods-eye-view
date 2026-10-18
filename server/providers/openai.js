import { defaultSourceRoot } from './common/source-root.js';
import { handleHudSummary } from './openai/hud-summary.js';
import { createDebugLogHandler } from './openai/debug-log.js';
import {
  createRealtimeOAuthLoginHandler,
  createRealtimeOAuthStatusHandler,
  createRealtimeTokenHandler,
} from './openai/realtime.js';
import { sameSiteGated } from './common/same-site.js';
import { createCodexOAuthLogin } from './openai/codex-auth.js';
import { createOpenVoiceRespondHandler } from './openai/open-voice.js';
import { handleOpenVoiceSpeak, handleOpenVoiceTranscribe } from './openai/open-voice-speech.js';
import { realtimeInstructions } from './openai/instructions.js';
import { GEV_REALTIME_TOOLS } from './openai/tools.js';

/**
 * Vite plugin: OpenAI Realtime ephemeral client secret.
 *
 * Keeps the selected cloud credential server-side while the browser connects
 * to the Realtime API over WebRTC with a short-lived secret.
 */
function openAiRealtimeProxy({
  sourceRoot = defaultSourceRoot,
  annotationGuidance,
  realtime = {},
} = {}) {
  const oauthLogin = createCodexOAuthLogin(realtime);
  function install(middlewares) {
    // Cost-bearing and log endpoints refuse cross-site browser requests
    // (see server/providers/common/same-site.js and SECURITY.md).
    middlewares.use('/api/openai/hud-summary', sameSiteGated(handleHudSummary));

    middlewares.use(
      '/api/realtime/debug-log',
      sameSiteGated(createDebugLogHandler({ sourceRoot })),
    );

    middlewares.use(
      '/api/realtime/token',
      sameSiteGated(
        createRealtimeTokenHandler({ ...realtime, annotationGuidance }),
      ),
    );

    // Open-source voice text turns (GEV_VOICE_ENGINE=open); same tools and
    // instructions as the Realtime session above.
    middlewares.use(
      '/api/voice/open/respond',
      sameSiteGated(
        createOpenVoiceRespondHandler({
          tools: realtime.tools || GEV_REALTIME_TOOLS,
          instructions: () => realtimeInstructions(annotationGuidance),
        }),
      ),
    );

    // Hosted speech for the open engine: Groq Whisper in, Fish/Chatterbox out.
    middlewares.use('/api/voice/open/transcribe', sameSiteGated(handleOpenVoiceTranscribe));
    middlewares.use('/api/voice/open/speak', sameSiteGated(handleOpenVoiceSpeak));

    middlewares.use(
      '/api/realtime/oauth-status',
      sameSiteGated(createRealtimeOAuthStatusHandler({ oauthLogin })),
    );

    middlewares.use(
      '/api/realtime/oauth-login',
      sameSiteGated(createRealtimeOAuthLoginHandler({ oauthLogin })),
    );
  }

  return {
    name: 'openai-realtime-proxy',
    configureServer(server) {
      install(server.middlewares);
      server.httpServer?.once('close', oauthLogin.dispose);
    },
    configurePreviewServer(server) {
      install(server.middlewares);
      server.httpServer?.once('close', oauthLogin.dispose);
    },
    closeBundle: oauthLogin.dispose,
  };
}

export { openAiRealtimeProxy };
