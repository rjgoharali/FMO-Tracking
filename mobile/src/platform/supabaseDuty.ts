import { supabase } from './supabase';

export async function createSupabaseDuty(fmoId: string, expectedEndTime: string, point: { latitude: number; longitude: number; accuracy: number }) {
  if (!supabase) throw new Error('Supabase is not configured');
  const { data: session, error } = await supabase.from('duty_sessions').insert({ fmo_id: fmoId, expected_end_time: expectedEndTime }).select('id').single();
  if (error) throw error;
  const { error: locationError } = await supabase.from('location_logs').insert({ duty_session_id: session.id, fmo_id: fmoId, ...point, recorded_at: new Date().toISOString() });
  if (locationError) throw locationError;
  return session.id as string;
}

export async function appendSupabaseLocation(sessionId: string, fmoId: string, point: { latitude: number; longitude: number; accuracy: number; speed?: number | null; battery_level?: number | null; recorded_at: string; client_point_id?: string }) {
  if (!supabase) return;
  const { error } = await supabase.from('location_logs').upsert({ duty_session_id: sessionId, fmo_id: fmoId, ...point }, { onConflict: 'client_point_id' });
  if (error) throw error;
}

export async function finishSupabaseDuty(sessionId: string, fmoId: string) {
  if (!supabase) return;
  const { error } = await supabase.from('duty_sessions').update({ status: 'COMPLETED', actual_end_time: new Date().toISOString() }).eq('id', sessionId).eq('fmo_id', fmoId);
  if (error) throw error;
}
