const API_BASE = import.meta.env.PROD ? '/api' : 'http://localhost:3001/api';

export async function generateVideo(imageBase64, mimeType, aspectRatio, options = {}) {
  const { model = 'default', resolution = '1080p', userPrompt, signal } = options;
  
  try {
    const response = await fetch(`${API_BASE}/veo`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      ...(signal ? { signal } : {}),
      body: JSON.stringify({
        imageBase64,
        mimeType,
        aspectRatio,
        model,
        resolution,
        ...(userPrompt ? { userPrompt } : {})
      })
    });
    
    const text = await response.text();
    let data;
    
    try {
      data = JSON.parse(text);
    } catch (parseError) {
      console.error('Failed to parse response:', text);
      throw new Error('Invalid response from server. Check server logs.');
    }
    
    if (!response.ok) {
      throw new Error(data.error || data.details || 'Video generation failed');
    }
    
    return data;
  } catch (error) {
    console.error('API call failed:', error);
    throw error;
  }
}

export async function checkHealth() {
  const response = await fetch(`${API_BASE}/health`);
  return response.json();
}

export async function checkModels() {
  const response = await fetch(`${API_BASE}/models`);
  return response.json();
}
