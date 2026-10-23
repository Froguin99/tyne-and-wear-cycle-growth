window.WD_MANIFEST = {
 "places": [
  {
   "key": "newcastle",
   "label": "Newcastle upon Tyne",
   "boundary": "newcastle/boundary.js",
   "scenarios": [
    {
     "key": "current_ltn_scenario",
     "label": "Current LTNs",
     "runs": [
      {
       "key": "betweenness",
       "file": "newcastle/run__current_ltn_scenario__betweenness.js"
      },
      {
       "key": "demand",
       "file": "newcastle/run__current_ltn_scenario__demand.js"
      },
      {
       "key": "betweenness_ltn_priority",
       "file": "newcastle/run__current_ltn_scenario__betweenness_ltn_priority.js"
      },
      {
       "key": "demand_ltn_priority",
       "file": "newcastle/run__current_ltn_scenario__demand_ltn_priority.js"
      }
     ],
     "metrics": "newcastle/metrics__current_ltn_scenario.js",
     "context": "newcastle/context__current_ltn_scenario.js"
    }
   ]
  },
  {
   "key": "gateshead",
   "label": "Gateshead",
   "boundary": "gateshead/boundary.js",
   "scenarios": [
    {
     "key": "current_ltn_scenario",
     "label": "Current LTNs",
     "runs": [
      {
       "key": "betweenness",
       "file": "gateshead/run__current_ltn_scenario__betweenness.js"
      },
      {
       "key": "demand",
       "file": "gateshead/run__current_ltn_scenario__demand.js"
      },
      {
       "key": "betweenness_ltn_priority",
       "file": "gateshead/run__current_ltn_scenario__betweenness_ltn_priority.js"
      },
      {
       "key": "demand_ltn_priority",
       "file": "gateshead/run__current_ltn_scenario__demand_ltn_priority.js"
      }
     ],
     "metrics": "gateshead/metrics__current_ltn_scenario.js",
     "context": "gateshead/context__current_ltn_scenario.js"
    }
   ]
  },
  {
   "key": "north_tyneside",
   "label": "North Tyneside",
   "boundary": "north_tyneside/boundary.js",
   "scenarios": [
    {
     "key": "current_ltn_scenario",
     "label": "Current LTNs",
     "runs": [
      {
       "key": "betweenness",
       "file": "north_tyneside/run__current_ltn_scenario__betweenness.js"
      },
      {
       "key": "demand",
       "file": "north_tyneside/run__current_ltn_scenario__demand.js"
      },
      {
       "key": "betweenness_ltn_priority",
       "file": "north_tyneside/run__current_ltn_scenario__betweenness_ltn_priority.js"
      },
      {
       "key": "demand_ltn_priority",
       "file": "north_tyneside/run__current_ltn_scenario__demand_ltn_priority.js"
      }
     ],
     "metrics": "north_tyneside/metrics__current_ltn_scenario.js",
     "context": "north_tyneside/context__current_ltn_scenario.js"
    }
   ]
  },
  {
   "key": "south_tyneside",
   "label": "South Tyneside",
   "boundary": "south_tyneside/boundary.js",
   "scenarios": [
    {
     "key": "current_ltn_scenario",
     "label": "Current LTNs",
     "runs": [
      {
       "key": "betweenness",
       "file": "south_tyneside/run__current_ltn_scenario__betweenness.js"
      },
      {
       "key": "demand",
       "file": "south_tyneside/run__current_ltn_scenario__demand.js"
      },
      {
       "key": "betweenness_ltn_priority",
       "file": "south_tyneside/run__current_ltn_scenario__betweenness_ltn_priority.js"
      },
      {
       "key": "demand_ltn_priority",
       "file": "south_tyneside/run__current_ltn_scenario__demand_ltn_priority.js"
      }
     ],
     "metrics": "south_tyneside/metrics__current_ltn_scenario.js",
     "context": "south_tyneside/context__current_ltn_scenario.js"
    }
   ]
  },
  {
   "key": "sunderland",
   "label": "Sunderland",
   "boundary": "sunderland/boundary.js",
   "scenarios": [
    {
     "key": "current_ltn_scenario",
     "label": "Current LTNs",
     "runs": [
      {
       "key": "betweenness",
       "file": "sunderland/run__current_ltn_scenario__betweenness.js"
      },
      {
       "key": "demand",
       "file": "sunderland/run__current_ltn_scenario__demand.js"
      },
      {
       "key": "betweenness_ltn_priority",
       "file": "sunderland/run__current_ltn_scenario__betweenness_ltn_priority.js"
      },
      {
       "key": "demand_ltn_priority",
       "file": "sunderland/run__current_ltn_scenario__demand_ltn_priority.js"
      }
     ],
     "metrics": "sunderland/metrics__current_ltn_scenario.js",
     "context": "sunderland/context__current_ltn_scenario.js"
    }
   ]
  }
 ],
 "strategies": [
  {
   "key": "betweenness",
   "label": "Betweenness",
   "color": "#3377BB",
   "dashed": false
  },
  {
   "key": "demand",
   "label": "Demand",
   "color": "#EE6677",
   "dashed": false
  },
  {
   "key": "betweenness_ltn_priority",
   "label": "Betweenness, LTN priority",
   "color": "#228833",
   "dashed": true
  },
  {
   "key": "demand_ltn_priority",
   "label": "Demand, LTN priority",
   "color": "#AA3377",
   "dashed": true
  }
 ]
};
