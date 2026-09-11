import { useMemo, type CSSProperties } from 'react'
import type { HeartEffectKind } from '../copy'
import { HeartIcon } from './icons'

export function HeartEffect({ kind }: { kind: HeartEffectKind }): React.JSX.Element {
  const params = useMemo(() => buildHeartParams(kind), [kind])
  return (
    <div className={`heart-effect heart-effect--${kind}`} aria-hidden="true">
      <span className="heart-effect__reduced">
        <HeartIcon />
      </span>
      {params.glow ? <span className="heart-effect__glow" /> : null}
      {params.core ? (
        <span className="heart-effect__core">
          <HeartIcon />
        </span>
      ) : null}
      {params.rise.map((heart) => (
        <span
          key={heart.key}
          className="heart-effect__rise"
          style={
            {
              left: heart.left,
              width: heart.size,
              height: heart.size,
              animationDelay: heart.delay,
              animationDuration: heart.dur,
              '--heart-drift': heart.drift,
              '--heart-scale': heart.scale
            } as CSSProperties
          }
        >
          <HeartIcon />
        </span>
      ))}
      {params.shards.map((shard) => (
        <span
          key={shard.key}
          className="heart-effect__shard"
          style={
            {
              '--shard-x': `${shard.x}px`,
              '--shard-y': `${shard.y}px`,
              width: shard.size,
              height: shard.size,
              animationDelay: shard.delay
            } as CSSProperties
          }
        >
          <HeartIcon />
        </span>
      ))}
      {params.orbit.map((orbit) => (
        <span
          key={orbit.key}
          className="heart-effect__orbit"
          style={
            {
              '--orbit-delay': orbit.delay,
              width: orbit.size,
              height: orbit.size
            } as CSSProperties
          }
        >
          <HeartIcon />
        </span>
      ))}
      {params.wave.map((ring) => (
        <span
          key={ring.key}
          className="heart-effect__wave"
          style={{ '--wave-delay': ring.delay } as CSSProperties}
        />
      ))}
      {params.shooting.map((shoot) => (
        <span
          key={shoot.key}
          className="heart-effect__shooting"
          style={
            {
              '--shoot-left': shoot.left,
              '--shoot-top': shoot.top,
              '--ribbon-wave': shoot.wave ?? '6px',
              width: shoot.size,
              height: shoot.size,
              animationDelay: shoot.delay,
              animationDuration: shoot.dur
            } as CSSProperties
          }
        >
          <HeartIcon />
        </span>
      ))}
      {kind === 'gift' ? (
        <span className="heart-effect__gift">
          <span className="heart-effect__gift-heart">
            <HeartIcon />
          </span>
          <span className="heart-effect__gift-lid" />
          <span className="heart-effect__gift-box" />
        </span>
      ) : null}
      {kind === 'cupid' ? (
        <span className="heart-effect__cupid">
          <span className="heart-effect__cupid-heart">
            <HeartIcon />
          </span>
          <span className="heart-effect__cupid-arrow" />
        </span>
      ) : null}
      {kind === 'balloon' ? (
        <span className="heart-effect__balloon">
          <span className="heart-effect__balloon-heart">
            <HeartIcon />
          </span>
          <span className="heart-effect__balloon-string" />
        </span>
      ) : null}
      {kind === 'superlike' ? (
        <span className="heart-effect__superlike">
          <span className="heart-effect__superlike-star" />
          <span className="heart-effect__superlike-heart">
            <HeartIcon />
          </span>
        </span>
      ) : null}
      {params.plus ? <span className="heart-effect__plus">+1</span> : null}
    </div>
  )
}

interface HeartEffectParams {
  glow: boolean
  core: boolean
  rise: Array<{
    key: number
    left: string
    size: number
    delay: string
    dur: string
    drift: string
    scale: number
  }>
  shards: Array<{ key: number; x: number; y: number; size: number; delay: string }>
  orbit: Array<{ key: number; delay: string; size: number }>
  wave: Array<{ key: number; delay: string }>
  shooting: Array<{
    key: number
    left: string
    top: string
    size: number
    delay: string
    dur: string
    wave?: string
  }>
  plus: boolean
}

function buildHeartParams(kind: HeartEffectKind): HeartEffectParams {
  const rand = (min: number, max: number): number => min + Math.random() * (max - min)
  const makeRise = (count: number): HeartEffectParams['rise'] =>
    Array.from({ length: count }, (_, key) => ({
      key,
      left: `${rand(2, 96)}%`,
      size: rand(10, 20),
      delay: `${rand(0, 400)}ms`,
      dur: `${rand(1150, 1700)}ms`,
      drift: `${rand(-18, 18)}px`,
      scale: rand(0.7, 1.5)
    }))
  const makeShards = (count: number, minR: number, maxR: number): HeartEffectParams['shards'] =>
    Array.from({ length: count }, (_, key) => {
      const angle = (key / count) * Math.PI * 2
      return {
        key,
        x: Math.round(Math.cos(angle) * rand(minR, maxR)),
        // 胶囊短轴只有 50px,短轴位移必须收紧;竖版由 CSS 交换长短轴
        y: Math.round(Math.sin(angle) * rand(12, 20)),
        size: rand(8, 14),
        delay: `${rand(0, 90)}ms`
      }
    })
  switch (kind) {
    case 'rain':
      return {
        glow: true,
        core: false,
        rise: makeRise(20),
        shards: [],
        orbit: [],
        wave: [],
        shooting: [],
        plus: true
      }
    case 'bloom':
      return {
        glow: true,
        core: true,
        rise: [],
        shards: makeShards(8, 40, 90),
        orbit: [],
        wave: [],
        shooting: [],
        plus: true
      }
    case 'orbit':
      return {
        glow: true,
        core: true,
        rise: [],
        shards: [],
        orbit: Array.from({ length: 6 }, (_, key) => ({
          key,
          delay: `${key * 75}ms`,
          size: rand(9, 13)
        })),
        wave: [],
        shooting: [],
        plus: true
      }
    case 'wave':
      return {
        glow: true,
        core: true,
        rise: [],
        shards: [],
        orbit: [],
        // 三圈光环依次向外扩散,像声波
        wave: Array.from({ length: 3 }, (_, key) => ({ key, delay: `${key * 250}ms` })),
        shooting: [],
        plus: true
      }
    case 'shooting':
      return {
        glow: true,
        core: false,
        rise: [],
        shards: [],
        orbit: [],
        wave: [],
        // 起点固定在长轴外侧,横版从左向右、竖版由 CSS 改为从下向上
        shooting: Array.from({ length: 5 }, (_, key) => ({
          key,
          left: '-16px',
          top: `${rand(15, 85)}%`,
          size: rand(9, 14),
          delay: `${key * 90 + rand(0, 40)}ms`,
          dur: `${rand(900, 1450)}ms`
        })),
        plus: true
      }
    case 'heartbeat':
      return {
        glow: true,
        core: true,
        rise: [],
        shards: [],
        orbit: [],
        wave: Array.from({ length: 2 }, (_, key) => ({ key, delay: `${300 + key * 420}ms` })),
        shooting: [],
        plus: true
      }
    case 'firework':
      return {
        glow: true,
        core: true,
        rise: [],
        shards: makeShards(12, 55, 105),
        orbit: [],
        wave: [],
        shooting: [],
        plus: true
      }
    case 'hug':
      return {
        glow: true,
        core: true,
        rise: [],
        shards: makeShards(2, 82, 96).map((heart) => ({ ...heart, delay: '0ms' })),
        orbit: [],
        wave: [],
        shooting: [],
        plus: true
      }
    case 'ribbon':
      return {
        glow: true,
        core: false,
        rise: [],
        shards: [],
        orbit: [],
        wave: [],
        shooting: Array.from({ length: 7 }, (_, key) => ({
          key,
          left: '102%',
          top: `${rand(16, 84)}%`,
          size: rand(8, 13),
          delay: `${key * 110}ms`,
          dur: `${rand(1200, 1550)}ms`,
          wave: `${key % 2 === 0 ? -6 : 6}px`
        })),
        plus: true
      }
    case 'gift':
    case 'cupid':
    case 'balloon':
    case 'superlike':
      return {
        glow: true,
        core: false,
        rise: [],
        shards: [],
        orbit: [],
        wave: [],
        shooting: [],
        plus: true
      }
  }
}
