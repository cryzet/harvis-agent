export const whatsappAudioToolDefinition = {
  type: "function",
  function: {
    name: "send_whatsapp_audio",
    description: "Envía la respuesta final al usuario actual de WhatsApp como audio. Úsala una sola vez y solo cuando el usuario o administrador haya pedido explícitamente una respuesta por audio. Pasa el texto completo de la respuesta que quieres que se escuche. Si pidió texto, no uses esta herramienta.",
    parameters: {
      type: "object",
      properties: {
        text: {
          type: "string",
          description: "Texto completo y conciso de la respuesta final que se convertirá en audio.",
        },
      },
      required: ["text"],
      additionalProperties: false,
    },
  },
};

export function createWhatsAppAudioToolHandler() {
  return async ({ text }, context) => {
    if (context?.role !== "admin" && context?.role !== "client") {
      throw new Error("La respuesta de audio solo está disponible para conversaciones de WhatsApp.");
    }
    if (context?.channelType !== "whatsapp" || typeof context.sendWhatsAppAudio !== "function") {
      throw new Error("Esta herramienta solo está disponible en una conversación de WhatsApp.");
    }
    if (context.audioRequested !== true) {
      throw new Error("Usa esta herramienta solo si el usuario pidió explícitamente una respuesta por audio.");
    }
    if (typeof text !== "string" || !text.trim()) {
      throw new Error("Indica el texto completo que se debe enviar como audio.");
    }
    return context.sendWhatsAppAudio(text.trim());
  };
}
