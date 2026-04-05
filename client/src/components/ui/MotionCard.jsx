import { motion } from 'framer-motion';

/**
 * Opacity-only reveal wrapper. 100ms max — no stagger, no layout animations.
 * Sales tool used under call pressure: content must appear instantly.
 */
export default function MotionCard({ children, className = '', style }) {
  return (
    <motion.div
      initial={{ opacity: 0 }}
      animate={{ opacity: 1 }}
      transition={{ duration: 0.1 }}
      className={className}
      style={style}
    >
      {children}
    </motion.div>
  );
}
