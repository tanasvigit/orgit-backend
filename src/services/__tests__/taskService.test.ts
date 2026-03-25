import { calculateNextRecurrenceDate } from '../taskService';

describe('Task Service', () => {
  describe('calculateNextRecurrenceDate', () => {
    it('should calculate next weekly recurrence', () => {
      const baseDate = new Date('2024-01-01');
      const nextDate = calculateNextRecurrenceDate('weekly', null, baseDate);
      const expectedDate = new Date('2024-01-08');
      expect(nextDate.toDateString()).toBe(expectedDate.toDateString());
    });

    it('should calculate next monthly recurrence', () => {
      const baseDate = new Date('2024-01-15');
      const nextDate = calculateNextRecurrenceDate('monthly', null, baseDate);
      const expectedDate = new Date('2024-02-15');
      expect(nextDate.toDateString()).toBe(expectedDate.toDateString());
    });

    it('should calculate next quarterly recurrence', () => {
      const baseDate = new Date('2024-01-01');
      const nextDate = calculateNextRecurrenceDate('quarterly', null, baseDate);
      const expectedDate = new Date('2024-04-01');
      expect(nextDate.toDateString()).toBe(expectedDate.toDateString());
    });

    it('should calculate next yearly recurrence', () => {
      const baseDate = new Date('2024-01-01');
      const nextDate = calculateNextRecurrenceDate('yearly', null, baseDate);
      const expectedDate = new Date('2025-01-01');
      expect(nextDate.toDateString()).toBe(expectedDate.toDateString());
    });

    it('should calculate next specific weekday recurrence', () => {
      const baseDate = new Date('2024-01-01'); // Monday
      const nextDate = calculateNextRecurrenceDate('specific_weekday', 5, baseDate); // Friday
      const expectedDate = new Date('2024-01-05'); // Friday
      expect(nextDate.toDateString()).toBe(expectedDate.toDateString());
    });
  });
});

