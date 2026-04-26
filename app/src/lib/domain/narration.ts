export type WeatherContext = {
  temp_f: number | null;
  summary: string;
  code_red: boolean;
  code_blue: boolean;
};

export type GroundingDoc = { doc_id: number; title: string; text: string };

export type ChatMessage = {
  role: 'system' | 'user' | 'assistant' | 'tool';
  content: string;
};
