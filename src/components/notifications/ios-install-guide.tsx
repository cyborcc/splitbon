import { BellRing, LayoutGrid, PlusSquare, Share, Smartphone } from 'lucide-react';
import styles from './ios-install-guide.module.css';

/** A local, translated illustration; no third-party player, cookies or automatic video download. */
export function IosInstallGuide({ title, steps }: { title: string; steps: [string, string, string, string] }) {
  const icons = [Share, PlusSquare, LayoutGrid, BellRing];

  return (
    <details className={styles.guide} data-testid="ios-install-animation">
      <summary className="cursor-pointer text-sm font-medium text-primary">{title}</summary>
      <ol className={styles.steps}>
        {steps.map((step, index) => {
          const Icon = icons[index]!;
          return (
            <li className={styles.step} key={step}>
              <div className={styles.phone} aria-hidden="true">
                <Smartphone className={styles.frame} />
                <Icon className={styles.action} />
                <span className={styles.number}>{index + 1}</span>
              </div>
              <p className="text-sm text-muted-foreground">{step}</p>
            </li>
          );
        })}
      </ol>
    </details>
  );
}
