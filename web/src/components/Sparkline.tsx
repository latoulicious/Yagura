import { Line, LineChart, ResponsiveContainer } from 'recharts'
import type { Tone } from '../api'

// Stroke per tone — healthy stays calm (text-tertiary); only a broken tone tints.
const STROKE: Record<Tone, string> = {
  healthy: 'var(--color-text-3)',
  degraded: 'var(--color-degraded)',
  offline: 'var(--color-offline)',
  unknown: 'var(--color-unknown)',
}

// One sparkline for host, probe, and container rows. Full-width — the wrapper
// sizes it (flex-1 or fixed); ResponsiveContainer redraws to 100%.
export function Sparkline({ data, tone = 'healthy' }: { data: number[]; tone?: Tone }) {
  if (data.length < 2) return <div className="h-6 w-full" />
  return (
    <div className="h-6 w-full">
      <ResponsiveContainer width="100%" height="100%">
        <LineChart data={data.map((v) => ({ v }))}>
          <Line
            type="monotone"
            dataKey="v"
            dot={false}
            stroke={STROKE[tone]}
            strokeWidth={1.5}
            isAnimationActive={false}
          />
        </LineChart>
      </ResponsiveContainer>
    </div>
  )
}
