import { z } from 'zod';
import { SYSTEM_CHAT_SERVER } from './bridge-event.ts';

const coordinate = (min:number,max:number) => z.number().finite().min(min).max(max);
const player = z.object({
  uuid:z.string().uuid(), name:z.string().regex(/^[A-Za-z0-9_]{1,16}$/),
  x:coordinate(-30_000_000,30_000_000), y:coordinate(-4096,4096), z:coordinate(-30_000_000,30_000_000),
  dx:coordinate(-16,16), dy:coordinate(-16,16), dz:coordinate(-16,16), distance:coordinate(0,16),
  bearing_degrees:coordinate(-180,180), line_of_sight:z.boolean()
}).strict();
const crosshair = z.object({
  type:z.enum(['none','miss','block','player','entity']),
  player_uuid:z.string().uuid().optional(), player_name:z.string().regex(/^[A-Za-z0-9_]{1,16}$/).optional(), distance:coordinate(0,8).optional(),
  block_id:z.string().regex(/^[a-z0-9_.-]+:[a-z0-9_./-]+$/).max(128).optional(),
  x:coordinate(-30_000_000,30_000_000).optional(),y:coordinate(-4096,4096).optional(),z:coordinate(-30_000_000,30_000_000).optional()
}).strict();
const self = z.object({
  x:coordinate(-30_000_000,30_000_000), y:coordinate(-4096,4096), z:coordinate(-30_000_000,30_000_000),
  yaw:coordinate(-360,360), pitch:coordinate(-90,90), vx:coordinate(-10,10), vy:coordinate(-10,10), vz:coordinate(-10,10),
  on_ground:z.boolean(), health:coordinate(0,1000), dimension:z.string().min(1).max(100),
  collision_ahead:z.boolean(), support_ahead:z.boolean(),
  step_status:z.enum(['clear','not_grounded','collision','no_support','unknown_chunk']).optional(),
  obstacle_block_id:z.string().regex(/^[a-z0-9_.-]+:[a-z0-9_./-]+$/).max(128).optional(),
  estimated_step_up:coordinate(0,2).optional(),
  nearest_support_block_id:z.string().regex(/^[a-z0-9_.-]+:[a-z0-9_./-]+$/).max(128).optional(),
  nearest_support_drop:coordinate(0,3).optional()
}).strict();
const time = z.string().refine(v=>Number.isFinite(Date.parse(v)),'invalid_timestamp');
const connected = z.object({
  session_id:z.string().uuid(), connected:z.literal(true), server:z.literal(SYSTEM_CHAT_SERVER), observed_at:time,
  self, players:z.array(player).max(8), crosshair
}).strict();
const disconnected = z.object({session_id:z.string().uuid(),connected:z.literal(false),server:z.null(),observed_at:time}).strict();
export const worldObservationSchema = z.discriminatedUnion('connected',[connected,disconnected]);
export type WorldObservation = z.infer<typeof worldObservationSchema>;

export function isObservationTimeCurrent(value:string,now=Date.now()):boolean {
  const observed=Date.parse(value);
  return Number.isFinite(observed)&&observed>=now-5000&&observed<=now+2000;
}
