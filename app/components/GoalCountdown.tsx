"use client";

import React, { useState, useEffect } from 'react';

interface GoalCountdownProps {
  endDateString: string | null;
}

const calculateTimeLeft = (endDate: Date | null): string => {
  if (!endDate) {
    return "No end date set";
  }

  const difference = +endDate - +new Date();
  let timeLeft = "";

  if (difference > 0) {
    const days = Math.floor(difference / (1000 * 60 * 60 * 24));
    const hours = Math.floor((difference / (1000 * 60 * 60)) % 24);
    const minutes = Math.floor((difference / 1000 / 60) % 60);
    const seconds = Math.floor((difference / 1000) % 60);

    if (days > 0) timeLeft += days + (days === 1 ? " day " : " days ");
    if (hours > 0 || days > 0) timeLeft += hours + (hours === 1 ? " hr " : " hrs ");
    if (minutes > 0 || hours > 0 || days > 0) timeLeft += minutes + (minutes === 1 ? " min " : " mins ");
    timeLeft += seconds + (seconds === 1 ? " sec" : " secs");
    
    return timeLeft.trim() ? timeLeft.trim() + " remaining" : "Ending soon";
  } else {
    return "Goal has ended";
  }
};

const GoalCountdown: React.FC<GoalCountdownProps> = ({ endDateString }) => {
  const [endDate, setEndDate] = useState<Date | null>(null);
  const [timeLeft, setTimeLeft] = useState<string>("");

  useEffect(() => {
    if (endDateString) {
      const parsedDate = new Date(endDateString);
      if (!isNaN(parsedDate.getTime())) {
        setEndDate(parsedDate);
      } else {
        setTimeLeft("Invalid end date");
        setEndDate(null); // Ensure we don't try to calculate with an invalid date
      }
    } else {
      setTimeLeft("No end date set");
      setEndDate(null);
    }
  }, [endDateString]);

  useEffect(() => {
    if (!endDate) {
      // If endDate becomes null (e.g. invalid date string), clear interval and set appropriate message.
      // This is already handled by the initial timeLeft set in the first useEffect if endDateString is null/invalid.
      return;
    }

    // Initial calculation
    setTimeLeft(calculateTimeLeft(endDate));

    const timer = setInterval(() => {
      setTimeLeft(calculateTimeLeft(endDate));
    }, 1000);

    // Clear interval on component unmount or if endDate changes
    return () => clearInterval(timer);
  }, [endDate]); // Rerun effect if endDate itself changes

  if (!endDateString) {
    return <p>End Date: Not set</p>;
  }
  if (timeLeft === "Invalid end date") {
      return <p style={{ color: 'orange' }}>End Date: Invalid</p>;
  }


  return (
    <p>
      End Date: {endDate ? endDate.toLocaleDateString() : 'N/A'}
      <br />
      Time Left: <strong>{timeLeft}</strong>
    </p>
  );
};

export default GoalCountdown; 