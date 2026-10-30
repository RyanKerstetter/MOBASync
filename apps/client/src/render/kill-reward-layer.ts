import { Container, Text } from 'pixi.js'
import {
  KILL_REWARD_LIFT,
  KILL_REWARD_LINE_HEIGHT,
  rewardLines,
  rewardPose,
  type KillRewardView,
} from './kill-reward.ts'

type Shown = {
  node: Container
  startedAt: number
  // Where it started from, so it rises from there.
  startY: number
}

// The gold and experience a kill paid, over where the victim fell (see kill-reward.ts): each is a stack of lines, gold over experience, that
// pops up, rises and fades, and is taken away when its time is up. Over the fog and the walls, like the damage numbers.
export class KillRewardLayer {
  readonly view = new Container()
  private readonly shown: Shown[] = []

  // Shows the kills just made (`rewards`, each told once) and moves the ones already up on to `now`.
  update(rewards: readonly KillRewardView[], now: number): void {
    for (const reward of rewards) this.add(reward, now)
    for (let index = this.shown.length - 1; index >= 0; index -= 1) {
      const shown = this.shown[index]
      const pose = rewardPose(now - shown.startedAt)
      if (pose.done) {
        shown.node.destroy({ children: true })
        this.shown.splice(index, 1)
        continue
      }
      shown.node.alpha = pose.alpha
      shown.node.scale.set(pose.scale)
      shown.node.y = shown.startY - pose.rise
    }
  }

  private add(reward: KillRewardView, now: number): void {
    const lines = rewardLines(reward)
    if (lines.length === 0) return
    const node = new Container()
    // The first line is the top one, and the last sits just over the body.
    lines.forEach((line, index) => {
      const text = new Text({
        text: line.text,
        style: { fill: line.color, fontSize: 18, fontFamily: 'Arial', fontWeight: 'bold', stroke: { color: '#0b1220', width: 4 } },
      })
      text.anchor.set(0.5, 1)
      text.y = -(lines.length - 1 - index) * KILL_REWARD_LINE_HEIGHT
      node.addChild(text)
    })
    const startY = reward.position.y - reward.radius - KILL_REWARD_LIFT
    node.position.set(reward.position.x, startY)
    this.view.addChild(node)
    this.shown.push({ node, startedAt: now, startY })
  }
}
